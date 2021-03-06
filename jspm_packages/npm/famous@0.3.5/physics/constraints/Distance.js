/* */ 
var Constraint = require("./Constraint");
var Vector = require("../../math/Vector");
function Distance(options) {
  this.options = Object.create(this.constructor.DEFAULT_OPTIONS);
  if (options)
    this.setOptions(options);
  this.impulse = new Vector();
  this.normal = new Vector();
  this.diffP = new Vector();
  this.diffV = new Vector();
  Constraint.call(this);
}
Distance.prototype = Object.create(Constraint.prototype);
Distance.prototype.constructor = Distance;
Distance.DEFAULT_OPTIONS = {
  anchor: null,
  length: 0,
  minLength: 0,
  period: 0,
  dampingRatio: 0
};
var pi = Math.PI;
Distance.prototype.setOptions = function setOptions(options) {
  if (options.anchor) {
    if (options.anchor.position instanceof Vector)
      this.options.anchor = options.anchor.position;
    if (options.anchor instanceof Vector)
      this.options.anchor = options.anchor;
    if (options.anchor instanceof Array)
      this.options.anchor = new Vector(options.anchor);
  }
  if (options.length !== undefined)
    this.options.length = options.length;
  if (options.dampingRatio !== undefined)
    this.options.dampingRatio = options.dampingRatio;
  if (options.period !== undefined)
    this.options.period = options.period;
  if (options.minLength !== undefined)
    this.options.minLength = options.minLength;
};
function _calcError(impulse, body) {
  return body.mass * impulse.norm();
}
Distance.prototype.setAnchor = function setAnchor(anchor) {
  if (!this.options.anchor)
    this.options.anchor = new Vector();
  this.options.anchor.set(anchor);
};
Distance.prototype.applyConstraint = function applyConstraint(targets, source, dt) {
  var n = this.normal;
  var diffP = this.diffP;
  var diffV = this.diffV;
  var impulse = this.impulse;
  var options = this.options;
  var dampingRatio = options.dampingRatio;
  var period = options.period;
  var minLength = options.minLength;
  var p2;
  var w2;
  if (source) {
    var v2 = source.velocity;
    p2 = source.position;
    w2 = source.inverseMass;
  } else {
    p2 = this.options.anchor;
    w2 = 0;
  }
  var length = this.options.length;
  for (var i = 0; i < targets.length; i++) {
    var body = targets[i];
    var v1 = body.velocity;
    var p1 = body.position;
    var w1 = body.inverseMass;
    diffP.set(p1.sub(p2));
    n.set(diffP.normalize());
    var dist = diffP.norm() - length;
    if (Math.abs(dist) < minLength)
      return ;
    if (source)
      diffV.set(v1.sub(v2));
    else
      diffV.set(v1);
    var effMass = 1 / (w1 + w2);
    var gamma;
    var beta;
    if (period === 0) {
      gamma = 0;
      beta = 1;
    } else {
      var c = 4 * effMass * pi * dampingRatio / period;
      var k = 4 * effMass * pi * pi / (period * period);
      gamma = 1 / (c + dt * k);
      beta = dt * k / (c + dt * k);
    }
    var antiDrift = beta / dt * dist;
    var lambda = -(n.dot(diffV) + antiDrift) / (gamma + dt / effMass);
    impulse.set(n.mult(dt * lambda));
    body.applyImpulse(impulse);
    if (source)
      source.applyImpulse(impulse.mult(-1));
  }
};
module.exports = Distance;
