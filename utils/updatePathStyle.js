const fs = require('fs');
const fsp = require('fs').promises;

const baseDir = '/var/run/strubs/mounts/';

//  /opt/strubs/utils

const updatePathFormat = async () => {
    
    //  get UUIDs
    const files = await fsp.readdir(baseDir, { withFileTypes: true });
    const uuids = files.map(file => file.name);

    for (let i = 0; i < uuids.length; ++i) {
        
        //  find subdirectories within UUID base directories
        const files = await fsp.readdir(`${baseDir}${uuids[i]}/strubs`, { withFileTypes: true });

        const fileName = files.find(file => file.name.length == 1 && /\d/.test(file.name[0])).name;
        const oldPath = `${ baseDir }${ uuids[i] }/strubs/${ fileName }`

        //  find files and move
        move(oldPath)
    }
};

const move = async (oldPath) => {
    const files = await fsp.readdir(oldPath, { withFileTypes: true });

    if (files.length == 1 && files[0].isDirectory()) {
        move(`${ oldPath }/${ files[0].name }`);
        return;
    }

    //  establish mountPoint
    let idx = baseDir.length;
    while (idx < oldPath.length && oldPath[idx] != '/')
        ++idx;

    const mountPoint = String(oldPath).substring(0, idx);
    const fileNames = files.map(file => file.name);

    for (let i = 0; i < fileNames.length; ++i) {
        const newPath = mountPoint + '/strubs/' + fileNames[i].substr(0, 2) + '/' + fileNames[i].substr(2, 2) + '/' + fileNames[i].substr(4, 2);

        //  make the new directories
        await fsp.mkdir(newPath, { recursive: true });

        //  move files
        await fsp.rename(oldPath + '/' + fileNames[i], newPath + '/' + fileNames[i]);
    }
};

//  updatePathFormat();

const removeOldPath = async () => {
    const files = await fsp.readdir(baseDir, { withFileTypes: true });
    const uuids = files.map(file => file.name);

    for (let i = 0; i < uuids.length; ++i) {
        
        //  find subdirectories within UUID base directories
        const files = await fsp.readdir(`${baseDir}${uuids[i]}/strubs`, { withFileTypes: true });

        //  get base directory with old path format
        const fileName = files.find(file => file.name.length == 1 && /\d/.test(file.name[0])).name;
        const oldPath = `${ baseDir }${ uuids[i] }/strubs/${ fileName }`

        //  remove remnant directories
        await fsp.rm(oldPath, { recursive: true });
    }
};

removeOldPath();