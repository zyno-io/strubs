const fs = require('fs');
const fsp = require('fs').promises;

const baseDir = '/var/run/strubs/mounts/';

const updatePathFormat = async () => {
    
    //  get UUIDs
    const files = await fsp.readdir(baseDir, { withFileTypes: true });
    const uuids = files.map(file => file.name);

    for (let i = 0; i < uuids.length; ++i) {
        
        //  find subdirectories within UUID base directories
        const files = await fsp.readdir(`${baseDir}${uuids[i]}/strubs`, { withFileTypes: true });
        const fileNames = files.filter(file => file.name.length == 1 && /[0-9a-z]/.test(file.name[0])).map(file => file.name);

        for (let j = 0; j < fileNames.length; ++j) {
            const oldPath = `${ baseDir }${ uuids[i] }/strubs/${ fileNames[j] }`;
            //  find files and move
            await move(oldPath);
        }
    }
};

const move = async (oldPath) => {
    const files = await fsp.readdir(oldPath, { withFileTypes: true });

    //  recursively find files
    if (files.length === 1 && files[0].isDirectory()) {
        await move(`${ oldPath }/${ files[0].name }`);
        return;
    }

    const fileNames = files.map(file => file.name);

    //  establish mountPoint
    let idx = baseDir.length;
    while (idx < oldPath.length && oldPath[idx] != '/')
        ++idx;

    const mountPoint = oldPath.substring(0, idx);
    const pathSegment = mountPoint + '/strubs/';

    for (let i = 0; i < fileNames.length; ++i) {
        const newPath = pathSegment + fileNames[i].substr(0, 2) + '/' + fileNames[i].substr(2, 2) + '/' + fileNames[i].substr(4, 2);

        //  make the new directories
        await fsp.mkdir(newPath, { recursive: true });

        //  move files
        await fsp.rename(oldPath + '/' + fileNames[i], newPath + '/' + fileNames[i]);        
    }

    idx = pathSegment.length;
    while (idx < oldPath.length && oldPath[idx] != '/')
        ++idx;

    //  remove old path
    await fsp.rm(oldPath.substring(0, idx), { recursive: true });
};

updatePathFormat();