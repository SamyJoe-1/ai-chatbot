'use strict';

const cafeBrain = require('./cafe');
const realEstateBrain = require('./realEstate');
const clinicBrain = require('./clinic');
const ecommerceBrain = require('./ecommerce');

const BRAINS = new Map([
  [cafeBrain.serviceType, cafeBrain],
  [realEstateBrain.serviceType, realEstateBrain],
  [clinicBrain.serviceType, clinicBrain],
  [ecommerceBrain.serviceType, ecommerceBrain],
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
