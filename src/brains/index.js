'use strict';

const cafeBrain = require('./cafe');
const realEstateBrain = require('./realEstate');
const clinicBrain = require('./clinic');

const BRAINS = new Map([
  [cafeBrain.serviceType, cafeBrain],
  [realEstateBrain.serviceType, realEstateBrain],
  [clinicBrain.serviceType, clinicBrain],
]);

function getBrain(serviceType) {
  return BRAINS.get(String(serviceType || '').trim()) || cafeBrain;
}

function listServiceTypes() {
  return Array.from(BRAINS.keys());
}

module.exports = {
  getBrain,
  listServiceTypes,
};
