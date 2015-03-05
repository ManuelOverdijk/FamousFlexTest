/* */ 
var Surface = require("../core/Surface");
var EventHandler = require("../core/EventHandler");
var RenderController = require("../views/RenderController");
function ToggleButton(options) {
  this.options = {
    content: ['', ''],
    offClasses: ['off'],
    onClasses: ['on'],
    size: undefined,
    outTransition: {
      curve: 'easeInOut',
      duration: 300
    },
    inTransition: {
      curve: 'easeInOut',
      duration: 300
    },
    toggleMode: ToggleButton.TOGGLE,
    crossfade: true
  };
  this._eventOutput = new EventHandler();
  EventHandler.setOutputHandler(this, this._eventOutput);
  this.offSurface = new Surface();
  this.offSurface.on('click', function() {
    if (this.options.toggleMode !== ToggleButton.OFF)
      this.select();
  }.bind(this));
  this.offSurface.pipe(this._eventOutput);
  this.onSurface = new Surface();
  this.onSurface.on('click', function() {
    if (this.options.toggleMode !== ToggleButton.ON)
      this.deselect();
  }.bind(this));
  this.onSurface.pipe(this._eventOutput);
  this.arbiter = new RenderController({overlap: this.options.crossfade});
  this.deselect();
  if (options)
    this.setOptions(options);
}
ToggleButton.OFF = 0;
ToggleButton.ON = 1;
ToggleButton.TOGGLE = 2;
ToggleButton.prototype.select = function select(suppressEvent) {
  this.selected = true;
  this.arbiter.show(this.onSurface, this.options.inTransition);
  if (!suppressEvent) {
    this._eventOutput.emit('select');
  }
};
ToggleButton.prototype.deselect = function deselect(suppressEvent) {
  this.selected = false;
  this.arbiter.show(this.offSurface, this.options.outTransition);
  if (!suppressEvent) {
    this._eventOutput.emit('deselect');
  }
};
ToggleButton.prototype.isSelected = function isSelected() {
  return this.selected;
};
ToggleButton.prototype.setOptions = function setOptions(options) {
  if (options.content !== undefined) {
    if (!(options.content instanceof Array))
      options.content = [options.content, options.content];
    this.options.content = options.content;
    this.offSurface.setContent(this.options.content[0]);
    this.onSurface.setContent(this.options.content[1]);
  }
  if (options.offClasses) {
    this.options.offClasses = options.offClasses;
    this.offSurface.setClasses(this.options.offClasses);
  }
  if (options.onClasses) {
    this.options.onClasses = options.onClasses;
    this.onSurface.setClasses(this.options.onClasses);
  }
  if (options.size !== undefined) {
    this.options.size = options.size;
    this.onSurface.setSize(this.options.size);
    this.offSurface.setSize(this.options.size);
  }
  if (options.toggleMode !== undefined)
    this.options.toggleMode = options.toggleMode;
  if (options.outTransition !== undefined)
    this.options.outTransition = options.outTransition;
  if (options.inTransition !== undefined)
    this.options.inTransition = options.inTransition;
  if (options.crossfade !== undefined) {
    this.options.crossfade = options.crossfade;
    this.arbiter.setOptions({overlap: this.options.crossfade});
  }
};
ToggleButton.prototype.getSize = function getSize() {
  return this.options.size;
};
ToggleButton.prototype.render = function render() {
  return this.arbiter.render();
};
module.exports = ToggleButton;
