/* */ 
var EventHandler = require("../core/EventHandler");
function TwoFingerSync() {
  this._eventInput = new EventHandler();
  this._eventOutput = new EventHandler();
  EventHandler.setInputHandler(this, this._eventInput);
  EventHandler.setOutputHandler(this, this._eventOutput);
  this.touchAEnabled = false;
  this.touchAId = 0;
  this.posA = null;
  this.timestampA = 0;
  this.touchBEnabled = false;
  this.touchBId = 0;
  this.posB = null;
  this.timestampB = 0;
  this._eventInput.on('touchstart', this.handleStart.bind(this));
  this._eventInput.on('touchmove', this.handleMove.bind(this));
  this._eventInput.on('touchend', this.handleEnd.bind(this));
  this._eventInput.on('touchcancel', this.handleEnd.bind(this));
}
TwoFingerSync.calculateAngle = function(posA, posB) {
  var diffX = posB[0] - posA[0];
  var diffY = posB[1] - posA[1];
  return Math.atan2(diffY, diffX);
};
TwoFingerSync.calculateDistance = function(posA, posB) {
  var diffX = posB[0] - posA[0];
  var diffY = posB[1] - posA[1];
  return Math.sqrt(diffX * diffX + diffY * diffY);
};
TwoFingerSync.calculateCenter = function(posA, posB) {
  return [(posA[0] + posB[0]) / 2, (posA[1] + posB[1]) / 2];
};
var _now = Date.now;
TwoFingerSync.prototype.handleStart = function handleStart(event) {
  for (var i = 0; i < event.changedTouches.length; i++) {
    var touch = event.changedTouches[i];
    if (!this.touchAEnabled) {
      this.touchAId = touch.identifier;
      this.touchAEnabled = true;
      this.posA = [touch.pageX, touch.pageY];
      this.timestampA = _now();
    } else if (!this.touchBEnabled) {
      this.touchBId = touch.identifier;
      this.touchBEnabled = true;
      this.posB = [touch.pageX, touch.pageY];
      this.timestampB = _now();
      this._startUpdate(event);
    }
  }
};
TwoFingerSync.prototype.handleMove = function handleMove(event) {
  if (!(this.touchAEnabled && this.touchBEnabled))
    return ;
  var prevTimeA = this.timestampA;
  var prevTimeB = this.timestampB;
  var diffTime;
  for (var i = 0; i < event.changedTouches.length; i++) {
    var touch = event.changedTouches[i];
    if (touch.identifier === this.touchAId) {
      this.posA = [touch.pageX, touch.pageY];
      this.timestampA = _now();
      diffTime = this.timestampA - prevTimeA;
    } else if (touch.identifier === this.touchBId) {
      this.posB = [touch.pageX, touch.pageY];
      this.timestampB = _now();
      diffTime = this.timestampB - prevTimeB;
    }
  }
  if (diffTime)
    this._moveUpdate(diffTime);
};
TwoFingerSync.prototype.handleEnd = function handleEnd(event) {
  for (var i = 0; i < event.changedTouches.length; i++) {
    var touch = event.changedTouches[i];
    if (touch.identifier === this.touchAId || touch.identifier === this.touchBId) {
      if (this.touchAEnabled && this.touchBEnabled) {
        this._eventOutput.emit('end', {
          touches: [this.touchAId, this.touchBId],
          angle: this._angle
        });
      }
      this.touchAEnabled = false;
      this.touchAId = 0;
      this.touchBEnabled = false;
      this.touchBId = 0;
    }
  }
};
module.exports = TwoFingerSync;
