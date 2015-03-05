/* */ 
var Body = require("./Body");
var Matrix = require("../../math/Matrix");
function Circle(options) {
  options = options || {};
  this.setRadius(options.radius || 0);
  Body.call(this, options);
}
Circle.prototype = Object.create(Body.prototype);
Circle.prototype.constructor = Circle;
Circle.prototype.setRadius = function setRadius(r) {
  this.radius = r;
  this.size = [2 * this.radius, 2 * this.radius];
  this.setMomentsOfInertia();
};
Circle.prototype.setMomentsOfInertia = function setMomentsOfInertia() {
  var m = this.mass;
  var r = this.radius;
  this.inertia = new Matrix([[0.25 * m * r * r, 0, 0], [0, 0.25 * m * r * r, 0], [0, 0, 0.5 * m * r * r]]);
  this.inverseInertia = new Matrix([[4 / (m * r * r), 0, 0], [0, 4 / (m * r * r), 0], [0, 0, 2 / (m * r * r)]]);
};
module.exports = Circle;
