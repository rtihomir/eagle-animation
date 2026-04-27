import { platform } from 'node:os';

const Cameras = [];

if (platform() === 'win32') {
  import('./canon')
    .then((canon) => {
      Cameras.push({ browser: canon.CameraBrowser, item: canon.Camera });
    })
    .catch(console.warn);
}

if (platform() === 'darwin' || platform() === 'linux') {
  import('./gphoto2')
    .then((gphoto2) => {
      Cameras.push({ browser: gphoto2.CameraBrowser, item: gphoto2.Camera });
    })
    .catch(console.warn);
}

let cachedCameras = {};
let pendingGetCamera = {};

export const getCameras = async () => {
  const availableCameras = [];

  for (const camType of Cameras) {
    const cameras = (await camType?.browser?.getCameras()) || [];
    for (const camera of cameras) {
      availableCameras.push({
        ...camera,
        type: 'NATIVE',
        id: `NATIVE-${camera.module}-${camera.deviceId}`,
      });
    }
  }

  return availableCameras;
};

export const flushCamera = async (id) => {
  cachedCameras[id] = null;
};

const doGetCamera = async (id) => {
  for (const camType of Cameras) {
    const cameras = (await camType?.browser?.getCameras()) || [];
    for (const camera of cameras) {
      if (id === `NATIVE-${camera.module}-${camera.deviceId}`) {
        const CameraClass = camType?.item;
        cachedCameras[id] = new CameraClass(camera.deviceId, {
          ...camera,
          type: 'NATIVE',
          id: `NATIVE-${camera.module}-${camera.deviceId}`,
        });
        return cachedCameras[id];
      }
    }
  }
  return null;
};

export const getCamera = async (id) => {
  if (cachedCameras[id]) {
    return cachedCameras[id];
  }
  if (pendingGetCamera[id]) {
    return pendingGetCamera[id];
  }
  const promise = doGetCamera(id);
  pendingGetCamera[id] = promise;
  try {
    return await promise;
  } finally {
    delete pendingGetCamera[id];
  }
};
