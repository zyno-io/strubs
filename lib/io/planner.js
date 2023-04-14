const _ = require('lodash');

const ioManager = require('./manager');
const Plan = require('./plan');

class Planner {
    generatePlan(fileSize) {
        let plan = new Plan();

        plan.fileSize = fileSize;

        // this will be heavily based on configuration later on in life

        // data & parity slice count
        plan.dataSliceCount = 4;
        plan.paritySliceCount = 2;

        // chunk size
        plan.chunkSize = 16384;

        // TODO: determine the slice size here so we can find available volumes
        // maybe???

        // determine what volumes are available
        let availableVolumes = ioManager.getWritableVolumes();

        // make sure we have at least as many available volumes as total slices
        if (availableVolumes.length < plan.totalSliceCount)
            throw new Error('not enough volumes available for planned slice count');

        // order into most space free, one per group, looping through each group
        // let sortedVolumes = this._getSortedVolumesByBytesFreeWithAlternatingGroups(availableVolumes);
        let sortedVolumes = this._getSortedVolumesByBytesFree(availableVolumes);

        let targetVolumes = sortedVolumes.slice(0, plan.dataSliceCount + plan.paritySliceCount);
        targetVolumes = _.shuffle(targetVolumes);

        // TEMP
        const bytesPerVol = Math.ceil(fileSize / plan.dataSliceCount);
        targetVolumes.forEach(vol => {
            vol.bytesPending += bytesPerVol;
        });

        // get the target volumes as the first x sorted volumes, where x is the target volumes
        let dataVolumes = targetVolumes.slice(0, plan.dataSliceCount);
        let parityVolumes = targetVolumes.slice(plan.dataSliceCount, plan.dataSliceCount + plan.paritySliceCount);

        // set the volume IDs for the data slices and parity slices
        plan.dataVolumes = _.map(dataVolumes, 'id');
        plan.parityVolumes = _.map(parityVolumes, 'id');

        return plan;
    }

    _getSortedVolumesByBytesFreeWithAlternatingGroups(volumes) {
        let volumesByGroup = {};

        volumes.forEach(volume => {
            if (!volumesByGroup[volume.deviceGroup])
                volumesByGroup[volume.deviceGroup] = [];
            volumesByGroup[volume.deviceGroup].push(volume);
        });

        for (let groupId in volumesByGroup) {
            let groupedVolumes = volumesByGroup[groupId];
            groupedVolumes.sort((a, b) => {
                return b.bytesFree - b.bytesPending - a.bytesFree - a.bytesPending;
            });
        }

        let sortedVolumes = [];
        while (sortedVolumes.length < volumes.length) {
            for (let groupId in volumesByGroup) {
                let groupedVolumes = volumesByGroup[groupId];
                if (groupedVolumes.length == 0) continue;
                sortedVolumes.push(groupedVolumes.shift());
            }
        }

        return sortedVolumes;
    }

    _getSortedVolumesByBytesFree(volumes) {
        let sortedVolumes = [ ...volumes ];
        sortedVolumes.sort((a, b) => {
            return b.bytesFree - b.bytesPending - a.bytesFree - a.bytesPending;
        });
        return sortedVolumes;
    }
}

module.exports = new Planner();