/** @typedef {import('pear-interface')} */

import 'bare-process/global';
import * as Y from 'yjs';
import chokidar from 'chokidar';
import path from 'bare-path';
import Hyperswarm from 'hyperswarm';
import Corestore from 'corestore';
import Hyperdrive from 'hyperdrive';
import process from 'bare-process';
import b4a from 'b4a';
import Localdrive from 'localdrive';
import fs from 'bare-fs';
import crypto from 'crypto';
import micromatch from 'micromatch';

const METADATA_DIRS = /(^|[/\\])\.(sync|store)/;
const TEMP_FILE_GLOBS = ['**/*.swp', '**/~*', '**/.#*', '**/.DS_Store'];
const LOCAL_ORIGIN = Symbol('local');

// Pear runtime hooks
const { teardown, config } = Pear;
const [directoryPath, driveKeyHex] = config.args;
if (!directoryPath) {
  console.error('Usage: <directory> [drive-key]');
  process.exit(1);
}

// Make sure directory exists
const directory = path.resolve(directoryPath);
if (!fs.existsSync(directory)) {
  fs.mkdirSync(directory, { recursive: true });
}
let cacheDirectory = null;

// Set up our drive key
const driveKey = driveKeyHex
  ? b4a.from(driveKeyHex, 'hex')
  : crypto.randomBytes(32);
console.log(
  driveKeyHex
    ? 'Joining existing drive'
    : `New drive created; key: ${b4a.toString(driveKey, 'hex')}`
);

// State
const ydoc = new Y.Doc();
const fileMap = ydoc.getMap('files');
const lastSyncedChangeHashes = new Map(); // key: relPath, value: Set of hash strings
let isSynced = !driveKeyHex;
let isSyncing = false;
let bufferedChanges = [];
let serverHyperdrive = null;
let swarmForSharing = null;

const mirrorFromRemoteDrive = async (received_object, socket) => {
  console.log('Mirror directory from an existing peer');
  const driveKeyBuffer = b4a.from(received_object.key, 'hex');
  const corestore = new Corestore(path.resolve(cacheDirectory), {
    writable: true,
  });

  const hyperdrive = new Hyperdrive(corestore, driveKeyBuffer);
  await hyperdrive.ready();

  try {
    const swarmForReceiving = new Hyperswarm();
    const done = hyperdrive.findingPeers();

    // TODO: Add timeout
    swarmForReceiving.on('connection', (mirrorSocket) => {
      hyperdrive.replicate(mirrorSocket);
    });

    const discoveryKey = hyperdrive.discoveryKey;
    swarmForReceiving.join(discoveryKey);
    console.log('Discovery key', discoveryKey);
    await swarmForReceiving.flush();
    await done();

    const local = new Localdrive(directory);
    const mirrordrive = hyperdrive.mirror(local);

    const fileKeys = [];
    for await (const diff of mirrordrive) {
      fileKeys.push(diff.key);
    }
    for (const fileKey of fileKeys) {
      if (fs.existsSync(directory + fileKey)) {
        const data = await fs.promises.readFile(directory + fileKey);
        const hash = sha256(data);
        if (!lastSyncedChangeHashes.has(fileKey)) {
          lastSyncedChangeHashes.set(fileKey, new Set());
        }
        lastSyncedChangeHashes.get(fileKey).add(hash);
      }
    }

    await hyperdrive.close();
    await swarmForReceiving.destroy();

    socket.write(JSON.stringify({ type: 'mirror-complete' }));
    applyBufferedChanges();
    isSyncing = false;
    isSynced = true;
  } catch (e) {
    console.log(e);
  }
};

const mirrorToRemoteDrive = async (socket) => {
  console.log('Mirror directory to a new peer');
  const corestore = new Corestore(path.resolve(cacheDirectory), {
    writable: true,
  });
  serverHyperdrive = new Hyperdrive(corestore, undefined);
  await serverHyperdrive.ready();
  const local = new Localdrive(directory);
  await local.ready();
  await local.mirror(serverHyperdrive).done();
  swarmForSharing = new Hyperswarm();
  const done = serverHyperdrive.findingPeers();
  swarmForSharing.on('connection', (mirrorSocket) =>
    serverHyperdrive.replicate(mirrorSocket)
  );
  swarmForSharing.join(serverHyperdrive.discoveryKey);
  console.log('Discovery key', serverHyperdrive.discoveryKey);
  await swarmForSharing.flush();
  await done();

  const hyperDriveKey = b4a.toString(serverHyperdrive.key, 'hex');
  socket.write(JSON.stringify({ type: 'drive-key', key: hyperDriveKey }));
};

const applyBufferedChanges = () => {
  bufferedChanges.forEach((data) => {
    Y.applyUpdate(ydoc, data);
  });
  bufferedChanges = [];
};

const handleJsonData = (received_object, socket) => {
  console.log('Received json data', received_object);
  if (isSynced) {
    if (received_object.type === 'mirror-approval') {
      isSyncing = true;
      void mirrorToRemoteDrive(socket);
    } else if (received_object.type === 'mirror-complete') {
      (async () => {
        await serverHyperdrive.close();
        await swarmForSharing.destroy();
        applyBufferedChanges();
        isSyncing = false;
      })();
    }
  } else {
    if (received_object.type === 'mirror-proposal') {
      if (isSyncing) {
        socket.write(JSON.stringify({ type: 'mirror-denial' }));
      } else {
        socket.write(JSON.stringify({ type: 'mirror-approval' }));
        isSyncing = true;
      }
    } else if (received_object.type === 'drive-key') {
      void mirrorFromRemoteDrive(received_object, socket);
    }
  }
};

const swarm = new Hyperswarm();
const ownPublicKey = b4a.toString(swarm.dht.defaultKeyPair.publicKey, 'hex');
cacheDirectory = path.join(path.dirname(directory), '.' + ownPublicKey);
swarm.on('connection', (socket, peerInfo) => {
  console.log('New peer connected');
  if (isSynced) {
    socket.write(JSON.stringify({ type: 'mirror-proposal' }));
  }

  // Receive updates from peers
  socket.on('data', (data) => {
    try {
      const received_object = JSON.parse(b4a.from(data));
      handleJsonData(received_object, socket, peerInfo);
      return;
    } catch {
      console.log('Received raw buffer object');
    }

    if (isSyncing) {
      bufferedChanges.push(data);
    } else {
      try {
        Y.applyUpdate(ydoc, data);
      } catch (err) {
        console.error('Failed to apply update:', err);
      }
    }
  });

  // Send local updates to peers
  const sendUpdate = (update) => {
    socket.write(update);
  };

  ydoc.on('update', sendUpdate);

  socket.on('close', () => {
    ydoc.off('update', sendUpdate);
    console.log('Peer disconnected');
  });
  socket.on('error', (error) => {
    ydoc.off('update', sendUpdate);
    console.error('Socket error:', error);
  });
});
await swarm.join(driveKey, { lookup: true, announce: true }).flushed();
console.log('🔗 Swarm joined. Awaiting peers…');

// Monitor local filesystem changes
const watch = chokidar.watch(directory, {
  ignored: [METADATA_DIRS, ...TEMP_FILE_GLOBS],
  ignoreInitial: true,
  depth: Infinity,
  persistent: true,
  awaitWriteFinish: true,
});
watch.on('all', async (event, filePath) => {
  if (micromatch.isMatch(filePath, TEMP_FILE_GLOBS)) {
    return;
  }

  const relPath = '/' + path.relative(directory, filePath).replace(/\\/g, '/');

  try {
    if (event === 'add' || event === 'change') {
      const data = await fs.promises.readFile(filePath);
      const newHash = sha256(data);

      if (lastSyncedChangeHashes.has(relPath)) {
        const hashes = lastSyncedChangeHashes.get(relPath);
        if (hashes.has(newHash)) {
          // No actual change, just sync, skip
          hashes.delete(newHash);
          if (hashes.size === 0) {
            lastSyncedChangeHashes.delete(relPath);
          }
          return;
        }
      }

      const timestamp = Date.now();
      ydoc.transact(() => {
        fileMap.set(relPath, { data, timestamp });
      }, LOCAL_ORIGIN);
      console.log(`↑ ${event.toUpperCase()}: ${relPath}`);
    } else if (event === 'unlink') {
      fileMap.delete(relPath);
      console.log(`✖ DELETE: ${relPath}`);
    }
  } catch (err) {
    console.error('Sync to drive error:', err);
  }
});

const sha256 = (data) => {
  return crypto.createHash('sha256').update(data).digest('hex');
};
// Apply remote changes to local filesystem
fileMap.observe((event, transaction) => {
  if (transaction.origin === LOCAL_ORIGIN) return; // Ignore local changes

  event.changes.keys.forEach((change, key) => {
    const filePath = path.join(directory, key);
    let hash = null;
    if (change.action === 'add' || change.action === 'update') {
      const { data } = fileMap.get(key);
      hash = sha256(data);

      fs.writeFile(filePath, data, 'utf8', (err) => {
        if (err) {
          console.error('Error writing file:', err);
        }
      });
    } else if (change.action === 'delete') {
      hash = sha256(b4a.from(''));
      fs.unlink(filePath, (err) => {
        if (err && err.code !== 'ENOENT') {
          console.error('Error deleting file:', err);
        }
      });
    }

    if (hash) {
      if (!lastSyncedChangeHashes.has(key)) {
        lastSyncedChangeHashes.set(key, new Set());
      }
      const hashes = lastSyncedChangeHashes.get(key);
      hashes.add(hash);
    }
  });
});

teardown(async () => {
  await swarm.destroy();
  watch.close();
  fs.rmSync(cacheDirectory, {
    force: true,
    recursive: true,
  });
});
