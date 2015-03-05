/* */ 
var EventHandler = require("../core/EventHandler");
var Transitionable = require("../transitions/Transitionable");
function Accumulator(value, eventName) {
  if (eventName === undefined)
    eventName = 'update';
  this._state = value && value.get && value.set ? value : new Transitionable(value || 0);
  this._eventInput = new EventHandler();
  EventHandler.setInputHandler(this, this._eventInput);
  this._eventInput.on(eventName, _handleUpdate.bind(this));
}
function _handleUpdate(data) {
  var delta = data.delta;
  var state = this.get();
  if (delta.constructor === state.constructor) {
    var newState = delta instanceof Array ? [state[0] + delta[0], state[1] + delta[1]] : state + delta;
    this.set(newState);
  }
}
Accumulator.prototype.get = function get() {
  return this._state.get();
};
Accumulator.prototype.set = function set(value) {
  this._state.set(value);
};
module.exports = Accumulator;
