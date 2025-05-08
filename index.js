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
const lastSyncedChangeHashes = new Map();
let isSynced = !driveKeyHex;
let isSyncing = false;
let bufferedChanges = [];
let serverHyperdrive = null;
let swarmForSharing = null;

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

const createCorestore = async () => {
  const ownKeyHex = b4a.toString(swarm.dht.defaultKeyPair.publicKey, 'hex');
  cacheDirectory = path.join(path.dirname(directory), `.${ownKeyHex}`);
  return new Corestore(path.resolve(cacheDirectory), { writable: true });
};

const mirrorFromRemoteDrive = async (receivedKeyHex, socket) => {
  console.log('Mirror directory from an existing peer');
  const key = b4a.from(receivedKeyHex, 'hex');
  const corestore = await createCorestore();
  const hyperdrive = new Hyperdrive(corestore, key);
  await hyperdrive.ready();

  const swarmForReceiving = new Hyperswarm();
  const done = hyperdrive.findingPeers();
  // TODO: Add timeout for safety
  swarmForReceiving.on('connection', (mirrorSocket) =>
    hyperdrive.replicate(mirrorSocket)
  );
  swarmForReceiving.join(hyperdrive.discoveryKey);
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
};

const mirrorToRemoteDrive = async (socket) => {
  console.log('Mirror directory to a new peer');
  const corestore = await createCorestore();
  serverHyperdrive = new Hyperdrive(corestore);
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
  socket.write(JSON.stringify({ type: 'drive-key', value: hyperDriveKey }));
};

const applyBufferedChanges = () => {
  bufferedChanges.forEach((data) => Y.applyUpdate(ydoc, data));
  bufferedChanges = [];
};

const handleSyncedState = (type, socket) => {
  switch (type) {
    case 'mirror-approval':
      isSyncing = true;
      void mirrorToRemoteDrive(socket);
      break;

    case 'mirror-complete':
      void (async () => {
        try {
          await serverHyperdrive.close();
          await swarmForSharing.destroy();
        } catch (err) {
          console.error('Error during mirror-complete cleanup:', err);
        } finally {
          applyBufferedChanges();
          isSyncing = false;
        }
      })();
      break;

    default:
      console.warn('Unexpected message type in synced state:', type);
  }
};

const handleUnsyncedState = (type, value, socket) => {
  switch (type) {
    // ToDo: Implement timeout and restart for getting a mirror-proposal request
    case 'mirror-proposal':
      const responseType = isSyncing ? 'mirror-denial' : 'mirror-approval';
      socket.write(JSON.stringify({ type: responseType }));
      if (!isSyncing) {
        isSyncing = true;
      }
      break;

    case 'drive-key':
      void mirrorFromRemoteDrive(value, socket);
      break;

    default:
      console.warn('Unexpected message type in unsynced state:', type);
  }
};

const handleJsonData = (received_object, socket) => {
  console.log('Received JSON data', received_object);

  if (!received_object || typeof received_object !== 'object') {
    console.warn('Invalid JSON data received.');
    return;
  }

  const { type, value } = received_object;

  if (isSynced) {
    handleSyncedState(type, socket);
  } else {
    handleUnsyncedState(type, value, socket);
  }
};

const swarm = new Hyperswarm();
swarm.on('connection', (socket) => {
  console.log('New peer connected');
  if (isSynced && !isSyncing)
    socket.write(JSON.stringify({ type: 'mirror-proposal' }));

  // Receive updates from peers
  socket.on('data', (data) => {
    try {
      const received_object = JSON.parse(b4a.from(data));
      return handleJsonData(received_object, socket);
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
  // ToDo: encrypt data
  const sendUpdate = (update) => socket.write(update);
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
console.log('Swarm joined. Awaiting peers…');

// Monitor local filesystem changes
const watch = chokidar.watch(directory, {
  ignored: [METADATA_DIRS, ...TEMP_FILE_GLOBS],
  ignoreInitial: true,
  depth: Infinity,
  persistent: true,
  awaitWriteFinish: true,
});

watch.on('all', async (event, filePath) => {
  if (!isSynced) return;
  if (micromatch.isMatch(filePath, TEMP_FILE_GLOBS)) return;
  const relPath = '/' + path.relative(directory, filePath).replace(/\\/g, '/');

  try {
    if (event === 'add' || event === 'change') {
      const data = await fs.promises.readFile(filePath);
      const newHash = sha256(data);

      if (lastSyncedChangeHashes.has(relPath)) {
        const hashes = lastSyncedChangeHashes.get(relPath);
        if (hashes.delete(newHash)) return;
        if (hashes.size === 0) lastSyncedChangeHashes.delete(relPath);
      }

      ydoc.transact(
        () => fileMap.set(relPath, { data, timestamp: Date.now() }),
        LOCAL_ORIGIN
      );
      console.log(`${event.toUpperCase()}: ${relPath}`);
    } else if (event === 'unlink') {
      fileMap.delete(relPath);
      console.log(`DELETE: ${relPath}`);
    }
  } catch (err) {
    console.error('Sync to drive error:', err);
  }
});

fileMap.observe((event, transaction) => {
  if (transaction.origin === LOCAL_ORIGIN) return; // Ignore local changes

  event.changes.keys.forEach((change, key) => {
    const filePath = path.join(directory, key);
    let content =
      change.action === 'delete' ? b4a.from('') : fileMap.get(key).data;
    const op =
      change.action === 'delete'
        ? fs.promises.unlink(filePath)
        : fs.promises.writeFile(filePath, content);

    op.catch(
      (err) =>
        err.code !== 'ENOENT' && console.error('Error writing file:', err)
    );

    const hash = sha256(content);
    if (!lastSyncedChangeHashes.has(key)) {
      lastSyncedChangeHashes.set(key, new Set());
    }
    lastSyncedChangeHashes.get(key).add(hash);
  });
});

teardown(async () => {
  await swarm.destroy();
  watch.close();
  fs.rmSync(cacheDirectory, { force: true, recursive: true });
});
