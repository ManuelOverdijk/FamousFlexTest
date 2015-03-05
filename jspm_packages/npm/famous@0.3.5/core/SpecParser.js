/* */ 
var Transform = require("./Transform");
function SpecParser() {
  this.result = {};
}
SpecParser._instance = new SpecParser();
SpecParser.parse = function parse(spec, context) {
  return SpecParser._instance.parse(spec, context);
};
SpecParser.prototype.parse = function parse(spec, context) {
  this.reset();
  this._parseSpec(spec, context, Transform.identity);
  return this.result;
};
SpecParser.prototype.reset = function reset() {
  this.result = {};
};
function _vecInContext(v, m) {
  return [v[0] * m[0] + v[1] * m[4] + v[2] * m[8], v[0] * m[1] + v[1] * m[5] + v[2] * m[9], v[0] * m[2] + v[1] * m[6] + v[2] * m[10]];
}
var _zeroZero = [0, 0];
SpecParser.prototype._parseSpec = function _parseSpec(spec, parentContext, sizeContext) {
  var id;
  var target;
  var transform;
  var opacity;
  var origin;
  var align;
  var size;
  if (typeof spec === 'number') {
    id = spec;
    transform = parentContext.transform;
    align = parentContext.align || _zeroZero;
    if (parentContext.size && align && (align[0] || align[1])) {
      var alignAdjust = [align[0] * parentContext.size[0], align[1] * parentContext.size[1], 0];
      transform = Transform.thenMove(transform, _vecInContext(alignAdjust, sizeContext));
    }
    this.result[id] = {
      transform: transform,
      opacity: parentContext.opacity,
      origin: parentContext.origin || _zeroZero,
      align: parentContext.align || _zeroZero,
      size: parentContext.size
    };
  } else if (!spec) {
    return ;
  } else if (spec instanceof Array) {
    for (var i = 0; i < spec.length; i++) {
      this._parseSpec(spec[i], parentContext, sizeContext);
    }
  } else {
    target = spec.target;
    transform = parentContext.transform;
    opacity = parentContext.opacity;
    origin = parentContext.origin;
    align = parentContext.align;
    size = parentContext.size;
    var nextSizeContext = sizeContext;
    if (spec.opacity !== undefined)
      opacity = parentContext.opacity * spec.opacity;
    if (spec.transform)
      transform = Transform.multiply(parentContext.transform, spec.transform);
    if (spec.origin) {
      origin = spec.origin;
      nextSizeContext = parentContext.transform;
    }
    if (spec.align)
      align = spec.align;
    if (spec.size || spec.proportions) {
      var parentSize = size;
      size = [size[0], size[1]];
      if (spec.size) {
        if (spec.size[0] !== undefined)
          size[0] = spec.size[0];
        if (spec.size[1] !== undefined)
          size[1] = spec.size[1];
      }
      if (spec.proportions) {
        if (spec.proportions[0] !== undefined)
          size[0] = size[0] * spec.proportions[0];
        if (spec.proportions[1] !== undefined)
          size[1] = size[1] * spec.proportions[1];
      }
      if (parentSize) {
        if (align && (align[0] || align[1]))
          transform = Transform.thenMove(transform, _vecInContext([align[0] * parentSize[0], align[1] * parentSize[1], 0], sizeContext));
        if (origin && (origin[0] || origin[1]))
          transform = Transform.moveThen([-origin[0] * size[0], -origin[1] * size[1], 0], transform);
      }
      nextSizeContext = parentContext.transform;
      origin = null;
      align = null;
    }
    this._parseSpec(target, {
      transform: transform,
      opacity: opacity,
      origin: origin,
      align: align,
      size: size
    }, nextSizeContext);
  }
};
module.exports = SpecParser;
