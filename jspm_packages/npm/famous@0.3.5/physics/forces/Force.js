/* */ 
var Vector = require("../../math/Vector");
var EventHandler = require("../../core/EventHandler");
function Force(force) {
  this.force = new Vector(force);
  this._eventOutput = new EventHandler();
  EventHandler.setOutputHandler(this, this._eventOutput);
}
Force.prototype.setOptions = function setOptions(options) {
  this._eventOutput.emit('change', options);
};
Force.prototype.applyForce = function applyForce(targets) {
  var length = targets.length;
  while (length--) {
    targets[length].applyForce(this.force);
  }
};
Force.prototype.getEnergy = function getEnergy() {
  return 0;
};
module.exports = Force;
