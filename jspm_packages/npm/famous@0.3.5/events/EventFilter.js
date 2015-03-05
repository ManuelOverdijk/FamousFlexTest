/* */ 
var EventHandler = require("../core/EventHandler");
function EventFilter(condition) {
  EventHandler.call(this);
  this._condition = condition;
}
EventFilter.prototype = Object.create(EventHandler.prototype);
EventFilter.prototype.constructor = EventFilter;
EventFilter.prototype.emit = function emit(type, data) {
  if (this._condition(type, data))
    return EventHandler.prototype.emit.apply(this, arguments);
};
EventFilter.prototype.trigger = EventFilter.prototype.emit;
module.exports = EventFilter;
