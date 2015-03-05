/* */ 
var EventHandler = require("../../core/EventHandler");
function Constraint() {
  this.options = this.options || {};
  this._eventOutput = new EventHandler();
  EventHandler.setOutputHandler(this, this._eventOutput);
}
Constraint.prototype.setOptions = function setOptions(options) {
  this._eventOutput.emit('change', options);
};
Constraint.prototype.applyConstraint = function applyConstraint() {};
Constraint.prototype.getEnergy = function getEnergy() {
  return 0;
};
module.exports = Constraint;
