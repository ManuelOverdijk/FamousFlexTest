"format register";
(function(global) {

  var defined = {};

  // indexOf polyfill for IE8
  var indexOf = Array.prototype.indexOf || function(item) {
    for (var i = 0, l = this.length; i < l; i++)
      if (this[i] === item)
        return i;
    return -1;
  }

  function dedupe(deps) {
    var newDeps = [];
    for (var i = 0, l = deps.length; i < l; i++)
      if (indexOf.call(newDeps, deps[i]) == -1)
        newDeps.push(deps[i])
    return newDeps;
  }

  function register(name, deps, declare, execute) {
    if (typeof name != 'string')
      throw "System.register provided no module name";
    
    var entry;

    // dynamic
    if (typeof declare == 'boolean') {
      entry = {
        declarative: false,
        deps: deps,
        execute: execute,
        executingRequire: declare
      };
    }
    else {
      // ES6 declarative
      entry = {
        declarative: true,
        deps: deps,
        declare: declare
      };
    }

    entry.name = name;
    
    // we never overwrite an existing define
    if (!defined[name])
      defined[name] = entry; 

    entry.deps = dedupe(entry.deps);

    // we have to normalize dependencies
    // (assume dependencies are normalized for now)
    // entry.normalizedDeps = entry.deps.map(normalize);
    entry.normalizedDeps = entry.deps;
  }

  function buildGroups(entry, groups) {
    groups[entry.groupIndex] = groups[entry.groupIndex] || [];

    if (indexOf.call(groups[entry.groupIndex], entry) != -1)
      return;

    groups[entry.groupIndex].push(entry);

    for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
      var depName = entry.normalizedDeps[i];
      var depEntry = defined[depName];
      
      // not in the registry means already linked / ES6
      if (!depEntry || depEntry.evaluated)
        continue;
      
      // now we know the entry is in our unlinked linkage group
      var depGroupIndex = entry.groupIndex + (depEntry.declarative != entry.declarative);

      // the group index of an entry is always the maximum
      if (depEntry.groupIndex === undefined || depEntry.groupIndex < depGroupIndex) {
        
        // if already in a group, remove from the old group
        if (depEntry.groupIndex !== undefined) {
          groups[depEntry.groupIndex].splice(indexOf.call(groups[depEntry.groupIndex], depEntry), 1);

          // if the old group is empty, then we have a mixed depndency cycle
          if (groups[depEntry.groupIndex].length == 0)
            throw new TypeError("Mixed dependency cycle detected");
        }

        depEntry.groupIndex = depGroupIndex;
      }

      buildGroups(depEntry, groups);
    }
  }

  function link(name) {
    var startEntry = defined[name];

    startEntry.groupIndex = 0;

    var groups = [];

    buildGroups(startEntry, groups);

    var curGroupDeclarative = !!startEntry.declarative == groups.length % 2;
    for (var i = groups.length - 1; i >= 0; i--) {
      var group = groups[i];
      for (var j = 0; j < group.length; j++) {
        var entry = group[j];

        // link each group
        if (curGroupDeclarative)
          linkDeclarativeModule(entry);
        else
          linkDynamicModule(entry);
      }
      curGroupDeclarative = !curGroupDeclarative; 
    }
  }

  // module binding records
  var moduleRecords = {};
  function getOrCreateModuleRecord(name) {
    return moduleRecords[name] || (moduleRecords[name] = {
      name: name,
      dependencies: [],
      exports: {}, // start from an empty module and extend
      importers: []
    })
  }

  function linkDeclarativeModule(entry) {
    // only link if already not already started linking (stops at circular)
    if (entry.module)
      return;

    var module = entry.module = getOrCreateModuleRecord(entry.name);
    var exports = entry.module.exports;

    var declaration = entry.declare.call(global, function(name, value) {
      module.locked = true;
      exports[name] = value;

      for (var i = 0, l = module.importers.length; i < l; i++) {
        var importerModule = module.importers[i];
        if (!importerModule.locked) {
          var importerIndex = indexOf.call(importerModule.dependencies, module);
          importerModule.setters[importerIndex](exports);
        }
      }

      module.locked = false;
      return value;
    });
    
    module.setters = declaration.setters;
    module.execute = declaration.execute;

    if (!module.setters || !module.execute)
      throw new TypeError("Invalid System.register form for " + entry.name);

    // now link all the module dependencies
    for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
      var depName = entry.normalizedDeps[i];
      var depEntry = defined[depName];
      var depModule = moduleRecords[depName];

      // work out how to set depExports based on scenarios...
      var depExports;

      if (depModule) {
        depExports = depModule.exports;
      }
      else if (depEntry && !depEntry.declarative) {
        depExports = { 'default': depEntry.module.exports, __useDefault: true };
      }
      // in the module registry
      else if (!depEntry) {
        depExports = load(depName);
      }
      // we have an entry -> link
      else {
        linkDeclarativeModule(depEntry);
        depModule = depEntry.module;
        depExports = depModule.exports;
      }

      // only declarative modules have dynamic bindings
      if (depModule && depModule.importers) {
        depModule.importers.push(module);
        module.dependencies.push(depModule);
      }
      else
        module.dependencies.push(null);

      // run the setter for this dependency
      if (module.setters[i])
        module.setters[i](depExports);
    }
  }

  // An analog to loader.get covering execution of all three layers (real declarative, simulated declarative, simulated dynamic)
  function getModule(name) {
    var exports;
    var entry = defined[name];

    if (!entry) {
      exports = load(name);
      if (!exports)
        throw new Error("Unable to load dependency " + name + ".");
    }

    else {
      if (entry.declarative)
        ensureEvaluated(name, []);
    
      else if (!entry.evaluated)
        linkDynamicModule(entry);

      exports = entry.module.exports;
    }

    if ((!entry || entry.declarative) && exports && exports.__useDefault)
      return exports['default'];

    return exports;
  }

  function linkDynamicModule(entry) {
    if (entry.module)
      return;

    var exports = {};

    var module = entry.module = { exports: exports, id: entry.name };

    // AMD requires execute the tree first
    if (!entry.executingRequire) {
      for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
        var depName = entry.normalizedDeps[i];
        var depEntry = defined[depName];
        if (depEntry)
          linkDynamicModule(depEntry);
      }
    }

    // now execute
    entry.evaluated = true;
    var output = entry.execute.call(global, function(name) {
      for (var i = 0, l = entry.deps.length; i < l; i++) {
        if (entry.deps[i] != name)
          continue;
        return getModule(entry.normalizedDeps[i]);
      }
      throw new TypeError('Module ' + name + ' not declared as a dependency.');
    }, exports, module);
    
    if (output)
      module.exports = output;
  }

  /*
   * Given a module, and the list of modules for this current branch,
   *  ensure that each of the dependencies of this module is evaluated
   *  (unless one is a circular dependency already in the list of seen
   *  modules, in which case we execute it)
   *
   * Then we evaluate the module itself depth-first left to right 
   * execution to match ES6 modules
   */
  function ensureEvaluated(moduleName, seen) {
    var entry = defined[moduleName];

    // if already seen, that means it's an already-evaluated non circular dependency
    if (entry.evaluated || !entry.declarative)
      return;

    // this only applies to declarative modules which late-execute

    seen.push(moduleName);

    for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
      var depName = entry.normalizedDeps[i];
      if (indexOf.call(seen, depName) == -1) {
        if (!defined[depName])
          load(depName);
        else
          ensureEvaluated(depName, seen);
      }
    }

    if (entry.evaluated)
      return;

    entry.evaluated = true;
    entry.module.execute.call(global);
  }

  // magical execution function
  var modules = {};
  function load(name) {
    if (modules[name])
      return modules[name];

    var entry = defined[name];

    // first we check if this module has already been defined in the registry
    if (!entry)
      throw "Module " + name + " not present.";

    // recursively ensure that the module and all its 
    // dependencies are linked (with dependency group handling)
    link(name);

    // now handle dependency execution in correct order
    ensureEvaluated(name, []);

    // remove from the registry
    defined[name] = undefined;

    var module = entry.declarative ? entry.module.exports : { 'default': entry.module.exports, '__useDefault': true };

    // return the defined module object
    return modules[name] = module;
  };

  return function(main, declare) {

    var System;

    // if there's a system loader, define onto it
    if (typeof System != 'undefined' && System.register) {
      declare(System);
      System['import'](main);
    }
    // otherwise, self execute
    else {
      declare(System = {
        register: register, 
        get: load, 
        set: function(name, module) {
          modules[name] = module; 
        },
        newModule: function(module) {
          return module;
        },
        global: global 
      });
      System.set('@empty', System.newModule({}));
      load(main);
    }
  };

})(typeof window != 'undefined' ? window : global)
/* ('mainModule', function(System) {
  System.register(...);
}); */

('main', function(System) {

System.register("npm:famous@0.3.5/core/Entity", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var entities = [];
  function get(id) {
    return entities[id];
  }
  function set(id, entity) {
    entities[id] = entity;
  }
  function register(entity) {
    var id = entities.length;
    set(id, entity);
    return id;
  }
  function unregister(id) {
    set(id, null);
  }
  module.exports = {
    register: register,
    unregister: unregister,
    get: get,
    set: set
  };
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/core/Transform", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var Transform = {};
  Transform.precision = 0.000001;
  Transform.identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  Transform.multiply4x4 = function multiply4x4(a, b) {
    return [a[0] * b[0] + a[4] * b[1] + a[8] * b[2] + a[12] * b[3], a[1] * b[0] + a[5] * b[1] + a[9] * b[2] + a[13] * b[3], a[2] * b[0] + a[6] * b[1] + a[10] * b[2] + a[14] * b[3], a[3] * b[0] + a[7] * b[1] + a[11] * b[2] + a[15] * b[3], a[0] * b[4] + a[4] * b[5] + a[8] * b[6] + a[12] * b[7], a[1] * b[4] + a[5] * b[5] + a[9] * b[6] + a[13] * b[7], a[2] * b[4] + a[6] * b[5] + a[10] * b[6] + a[14] * b[7], a[3] * b[4] + a[7] * b[5] + a[11] * b[6] + a[15] * b[7], a[0] * b[8] + a[4] * b[9] + a[8] * b[10] + a[12] * b[11], a[1] * b[8] + a[5] * b[9] + a[9] * b[10] + a[13] * b[11], a[2] * b[8] + a[6] * b[9] + a[10] * b[10] + a[14] * b[11], a[3] * b[8] + a[7] * b[9] + a[11] * b[10] + a[15] * b[11], a[0] * b[12] + a[4] * b[13] + a[8] * b[14] + a[12] * b[15], a[1] * b[12] + a[5] * b[13] + a[9] * b[14] + a[13] * b[15], a[2] * b[12] + a[6] * b[13] + a[10] * b[14] + a[14] * b[15], a[3] * b[12] + a[7] * b[13] + a[11] * b[14] + a[15] * b[15]];
  };
  Transform.multiply = function multiply(a, b) {
    return [a[0] * b[0] + a[4] * b[1] + a[8] * b[2], a[1] * b[0] + a[5] * b[1] + a[9] * b[2], a[2] * b[0] + a[6] * b[1] + a[10] * b[2], 0, a[0] * b[4] + a[4] * b[5] + a[8] * b[6], a[1] * b[4] + a[5] * b[5] + a[9] * b[6], a[2] * b[4] + a[6] * b[5] + a[10] * b[6], 0, a[0] * b[8] + a[4] * b[9] + a[8] * b[10], a[1] * b[8] + a[5] * b[9] + a[9] * b[10], a[2] * b[8] + a[6] * b[9] + a[10] * b[10], 0, a[0] * b[12] + a[4] * b[13] + a[8] * b[14] + a[12], a[1] * b[12] + a[5] * b[13] + a[9] * b[14] + a[13], a[2] * b[12] + a[6] * b[13] + a[10] * b[14] + a[14], 1];
  };
  Transform.thenMove = function thenMove(m, t) {
    if (!t[2])
      t[2] = 0;
    return [m[0], m[1], m[2], 0, m[4], m[5], m[6], 0, m[8], m[9], m[10], 0, m[12] + t[0], m[13] + t[1], m[14] + t[2], 1];
  };
  Transform.moveThen = function moveThen(v, m) {
    if (!v[2])
      v[2] = 0;
    var t0 = v[0] * m[0] + v[1] * m[4] + v[2] * m[8];
    var t1 = v[0] * m[1] + v[1] * m[5] + v[2] * m[9];
    var t2 = v[0] * m[2] + v[1] * m[6] + v[2] * m[10];
    return Transform.thenMove(m, [t0, t1, t2]);
  };
  Transform.translate = function translate(x, y, z) {
    if (z === undefined)
      z = 0;
    return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
  };
  Transform.thenScale = function thenScale(m, s) {
    return [s[0] * m[0], s[1] * m[1], s[2] * m[2], 0, s[0] * m[4], s[1] * m[5], s[2] * m[6], 0, s[0] * m[8], s[1] * m[9], s[2] * m[10], 0, s[0] * m[12], s[1] * m[13], s[2] * m[14], 1];
  };
  Transform.scale = function scale(x, y, z) {
    if (z === undefined)
      z = 1;
    if (y === undefined)
      y = x;
    return [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1];
  };
  Transform.rotateX = function rotateX(theta) {
    var cosTheta = Math.cos(theta);
    var sinTheta = Math.sin(theta);
    return [1, 0, 0, 0, 0, cosTheta, sinTheta, 0, 0, -sinTheta, cosTheta, 0, 0, 0, 0, 1];
  };
  Transform.rotateY = function rotateY(theta) {
    var cosTheta = Math.cos(theta);
    var sinTheta = Math.sin(theta);
    return [cosTheta, 0, -sinTheta, 0, 0, 1, 0, 0, sinTheta, 0, cosTheta, 0, 0, 0, 0, 1];
  };
  Transform.rotateZ = function rotateZ(theta) {
    var cosTheta = Math.cos(theta);
    var sinTheta = Math.sin(theta);
    return [cosTheta, sinTheta, 0, 0, -sinTheta, cosTheta, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  };
  Transform.rotate = function rotate(phi, theta, psi) {
    var cosPhi = Math.cos(phi);
    var sinPhi = Math.sin(phi);
    var cosTheta = Math.cos(theta);
    var sinTheta = Math.sin(theta);
    var cosPsi = Math.cos(psi);
    var sinPsi = Math.sin(psi);
    var result = [cosTheta * cosPsi, cosPhi * sinPsi + sinPhi * sinTheta * cosPsi, sinPhi * sinPsi - cosPhi * sinTheta * cosPsi, 0, -cosTheta * sinPsi, cosPhi * cosPsi - sinPhi * sinTheta * sinPsi, sinPhi * cosPsi + cosPhi * sinTheta * sinPsi, 0, sinTheta, -sinPhi * cosTheta, cosPhi * cosTheta, 0, 0, 0, 0, 1];
    return result;
  };
  Transform.rotateAxis = function rotateAxis(v, theta) {
    var sinTheta = Math.sin(theta);
    var cosTheta = Math.cos(theta);
    var verTheta = 1 - cosTheta;
    var xxV = v[0] * v[0] * verTheta;
    var xyV = v[0] * v[1] * verTheta;
    var xzV = v[0] * v[2] * verTheta;
    var yyV = v[1] * v[1] * verTheta;
    var yzV = v[1] * v[2] * verTheta;
    var zzV = v[2] * v[2] * verTheta;
    var xs = v[0] * sinTheta;
    var ys = v[1] * sinTheta;
    var zs = v[2] * sinTheta;
    var result = [xxV + cosTheta, xyV + zs, xzV - ys, 0, xyV - zs, yyV + cosTheta, yzV + xs, 0, xzV + ys, yzV - xs, zzV + cosTheta, 0, 0, 0, 0, 1];
    return result;
  };
  Transform.aboutOrigin = function aboutOrigin(v, m) {
    var t0 = v[0] - (v[0] * m[0] + v[1] * m[4] + v[2] * m[8]);
    var t1 = v[1] - (v[0] * m[1] + v[1] * m[5] + v[2] * m[9]);
    var t2 = v[2] - (v[0] * m[2] + v[1] * m[6] + v[2] * m[10]);
    return Transform.thenMove(m, [t0, t1, t2]);
  };
  Transform.skew = function skew(phi, theta, psi) {
    return [1, Math.tan(theta), 0, 0, Math.tan(psi), 1, 0, 0, 0, Math.tan(phi), 1, 0, 0, 0, 0, 1];
  };
  Transform.skewX = function skewX(angle) {
    return [1, 0, 0, 0, Math.tan(angle), 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  };
  Transform.skewY = function skewY(angle) {
    return [1, Math.tan(angle), 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  };
  Transform.perspective = function perspective(focusZ) {
    return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, -1 / focusZ, 0, 0, 0, 1];
  };
  Transform.getTranslate = function getTranslate(m) {
    return [m[12], m[13], m[14]];
  };
  Transform.inverse = function inverse(m) {
    var c0 = m[5] * m[10] - m[6] * m[9];
    var c1 = m[4] * m[10] - m[6] * m[8];
    var c2 = m[4] * m[9] - m[5] * m[8];
    var c4 = m[1] * m[10] - m[2] * m[9];
    var c5 = m[0] * m[10] - m[2] * m[8];
    var c6 = m[0] * m[9] - m[1] * m[8];
    var c8 = m[1] * m[6] - m[2] * m[5];
    var c9 = m[0] * m[6] - m[2] * m[4];
    var c10 = m[0] * m[5] - m[1] * m[4];
    var detM = m[0] * c0 - m[1] * c1 + m[2] * c2;
    var invD = 1 / detM;
    var result = [invD * c0, -invD * c4, invD * c8, 0, -invD * c1, invD * c5, -invD * c9, 0, invD * c2, -invD * c6, invD * c10, 0, 0, 0, 0, 1];
    result[12] = -m[12] * result[0] - m[13] * result[4] - m[14] * result[8];
    result[13] = -m[12] * result[1] - m[13] * result[5] - m[14] * result[9];
    result[14] = -m[12] * result[2] - m[13] * result[6] - m[14] * result[10];
    return result;
  };
  Transform.transpose = function transpose(m) {
    return [m[0], m[4], m[8], m[12], m[1], m[5], m[9], m[13], m[2], m[6], m[10], m[14], m[3], m[7], m[11], m[15]];
  };
  function _normSquared(v) {
    return v.length === 2 ? v[0] * v[0] + v[1] * v[1] : v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
  }
  function _norm(v) {
    return Math.sqrt(_normSquared(v));
  }
  function _sign(n) {
    return n < 0 ? -1 : 1;
  }
  Transform.interpret = function interpret(M) {
    var x = [M[0], M[1], M[2]];
    var sgn = _sign(x[0]);
    var xNorm = _norm(x);
    var v = [x[0] + sgn * xNorm, x[1], x[2]];
    var mult = 2 / _normSquared(v);
    if (mult >= Infinity) {
      return {
        translate: Transform.getTranslate(M),
        rotate: [0, 0, 0],
        scale: [0, 0, 0],
        skew: [0, 0, 0]
      };
    }
    var Q1 = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
    Q1[0] = 1 - mult * v[0] * v[0];
    Q1[5] = 1 - mult * v[1] * v[1];
    Q1[10] = 1 - mult * v[2] * v[2];
    Q1[1] = -mult * v[0] * v[1];
    Q1[2] = -mult * v[0] * v[2];
    Q1[6] = -mult * v[1] * v[2];
    Q1[4] = Q1[1];
    Q1[8] = Q1[2];
    Q1[9] = Q1[6];
    var MQ1 = Transform.multiply(Q1, M);
    var x2 = [MQ1[5], MQ1[6]];
    var sgn2 = _sign(x2[0]);
    var x2Norm = _norm(x2);
    var v2 = [x2[0] + sgn2 * x2Norm, x2[1]];
    var mult2 = 2 / _normSquared(v2);
    var Q2 = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
    Q2[5] = 1 - mult2 * v2[0] * v2[0];
    Q2[10] = 1 - mult2 * v2[1] * v2[1];
    Q2[6] = -mult2 * v2[0] * v2[1];
    Q2[9] = Q2[6];
    var Q = Transform.multiply(Q2, Q1);
    var R = Transform.multiply(Q, M);
    var remover = Transform.scale(R[0] < 0 ? -1 : 1, R[5] < 0 ? -1 : 1, R[10] < 0 ? -1 : 1);
    R = Transform.multiply(R, remover);
    Q = Transform.multiply(remover, Q);
    var result = {};
    result.translate = Transform.getTranslate(M);
    result.rotate = [Math.atan2(-Q[6], Q[10]), Math.asin(Q[2]), Math.atan2(-Q[1], Q[0])];
    if (!result.rotate[0]) {
      result.rotate[0] = 0;
      result.rotate[2] = Math.atan2(Q[4], Q[5]);
    }
    result.scale = [R[0], R[5], R[10]];
    result.skew = [Math.atan2(R[9], result.scale[2]), Math.atan2(R[8], result.scale[2]), Math.atan2(R[4], result.scale[0])];
    if (Math.abs(result.rotate[0]) + Math.abs(result.rotate[2]) > 1.5 * Math.PI) {
      result.rotate[1] = Math.PI - result.rotate[1];
      if (result.rotate[1] > Math.PI)
        result.rotate[1] -= 2 * Math.PI;
      if (result.rotate[1] < -Math.PI)
        result.rotate[1] += 2 * Math.PI;
      if (result.rotate[0] < 0)
        result.rotate[0] += Math.PI;
      else
        result.rotate[0] -= Math.PI;
      if (result.rotate[2] < 0)
        result.rotate[2] += Math.PI;
      else
        result.rotate[2] -= Math.PI;
    }
    return result;
  };
  Transform.average = function average(M1, M2, t) {
    t = t === undefined ? 0.5 : t;
    var specM1 = Transform.interpret(M1);
    var specM2 = Transform.interpret(M2);
    var specAvg = {
      translate: [0, 0, 0],
      rotate: [0, 0, 0],
      scale: [0, 0, 0],
      skew: [0, 0, 0]
    };
    for (var i = 0; i < 3; i++) {
      specAvg.translate[i] = (1 - t) * specM1.translate[i] + t * specM2.translate[i];
      specAvg.rotate[i] = (1 - t) * specM1.rotate[i] + t * specM2.rotate[i];
      specAvg.scale[i] = (1 - t) * specM1.scale[i] + t * specM2.scale[i];
      specAvg.skew[i] = (1 - t) * specM1.skew[i] + t * specM2.skew[i];
    }
    return Transform.build(specAvg);
  };
  Transform.build = function build(spec) {
    var scaleMatrix = Transform.scale(spec.scale[0], spec.scale[1], spec.scale[2]);
    var skewMatrix = Transform.skew(spec.skew[0], spec.skew[1], spec.skew[2]);
    var rotateMatrix = Transform.rotate(spec.rotate[0], spec.rotate[1], spec.rotate[2]);
    return Transform.thenMove(Transform.multiply(Transform.multiply(rotateMatrix, skewMatrix), scaleMatrix), spec.translate);
  };
  Transform.equals = function equals(a, b) {
    return !Transform.notEquals(a, b);
  };
  Transform.notEquals = function notEquals(a, b) {
    if (a === b)
      return false;
    return !(a && b) || a[12] !== b[12] || a[13] !== b[13] || a[14] !== b[14] || a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2] || a[4] !== b[4] || a[5] !== b[5] || a[6] !== b[6] || a[8] !== b[8] || a[9] !== b[9] || a[10] !== b[10];
  };
  Transform.normalizeRotation = function normalizeRotation(rotation) {
    var result = rotation.slice(0);
    if (result[0] === Math.PI * 0.5 || result[0] === -Math.PI * 0.5) {
      result[0] = -result[0];
      result[1] = Math.PI - result[1];
      result[2] -= Math.PI;
    }
    if (result[0] > Math.PI * 0.5) {
      result[0] = result[0] - Math.PI;
      result[1] = Math.PI - result[1];
      result[2] -= Math.PI;
    }
    if (result[0] < -Math.PI * 0.5) {
      result[0] = result[0] + Math.PI;
      result[1] = -Math.PI - result[1];
      result[2] -= Math.PI;
    }
    while (result[1] < -Math.PI)
      result[1] += 2 * Math.PI;
    while (result[1] >= Math.PI)
      result[1] -= 2 * Math.PI;
    while (result[2] < -Math.PI)
      result[2] += 2 * Math.PI;
    while (result[2] >= Math.PI)
      result[2] -= 2 * Math.PI;
    return result;
  };
  Transform.inFront = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0.001, 1];
  Transform.behind = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -0.001, 1];
  module.exports = Transform;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/core/EventEmitter", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  function EventEmitter() {
    this.listeners = {};
    this._owner = this;
  }
  EventEmitter.prototype.emit = function emit(type, event) {
    var handlers = this.listeners[type];
    if (handlers) {
      for (var i = 0; i < handlers.length; i++) {
        handlers[i].call(this._owner, event);
      }
    }
    return this;
  };
  EventEmitter.prototype.on = function on(type, handler) {
    if (!(type in this.listeners))
      this.listeners[type] = [];
    var index = this.listeners[type].indexOf(handler);
    if (index < 0)
      this.listeners[type].push(handler);
    return this;
  };
  EventEmitter.prototype.addListener = EventEmitter.prototype.on;
  EventEmitter.prototype.removeListener = function removeListener(type, handler) {
    var listener = this.listeners[type];
    if (listener !== undefined) {
      var index = listener.indexOf(handler);
      if (index >= 0)
        listener.splice(index, 1);
    }
    return this;
  };
  EventEmitter.prototype.bindThis = function bindThis(owner) {
    this._owner = owner;
  };
  module.exports = EventEmitter;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/core/ElementAllocator", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  function ElementAllocator(container) {
    if (!container)
      container = document.createDocumentFragment();
    this.container = container;
    this.detachedNodes = {};
    this.nodeCount = 0;
  }
  ElementAllocator.prototype.migrate = function migrate(container) {
    var oldContainer = this.container;
    if (container === oldContainer)
      return ;
    if (oldContainer instanceof DocumentFragment) {
      container.appendChild(oldContainer);
    } else {
      while (oldContainer.hasChildNodes()) {
        container.appendChild(oldContainer.firstChild);
      }
    }
    this.container = container;
  };
  ElementAllocator.prototype.allocate = function allocate(type) {
    type = type.toLowerCase();
    if (!(type in this.detachedNodes))
      this.detachedNodes[type] = [];
    var nodeStore = this.detachedNodes[type];
    var result;
    if (nodeStore.length > 0) {
      result = nodeStore.pop();
    } else {
      result = document.createElement(type);
      this.container.appendChild(result);
    }
    this.nodeCount++;
    return result;
  };
  ElementAllocator.prototype.deallocate = function deallocate(element) {
    var nodeType = element.nodeName.toLowerCase();
    var nodeStore = this.detachedNodes[nodeType];
    nodeStore.push(element);
    this.nodeCount--;
  };
  ElementAllocator.prototype.getNodeCount = function getNodeCount() {
    return this.nodeCount;
  };
  module.exports = ElementAllocator;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/utilities/Utility", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var Utility = {};
  Utility.Direction = {
    X: 0,
    Y: 1,
    Z: 2
  };
  Utility.after = function after(count, callback) {
    var counter = count;
    return function() {
      counter--;
      if (counter === 0)
        callback.apply(this, arguments);
    };
  };
  Utility.loadURL = function loadURL(url, callback) {
    var xhr = new XMLHttpRequest();
    xhr.onreadystatechange = function onreadystatechange() {
      if (this.readyState === 4) {
        if (callback)
          callback(this.responseText);
      }
    };
    xhr.open('GET', url);
    xhr.send();
  };
  Utility.createDocumentFragmentFromHTML = function createDocumentFragmentFromHTML(html) {
    var element = document.createElement('div');
    element.innerHTML = html;
    var result = document.createDocumentFragment();
    while (element.hasChildNodes())
      result.appendChild(element.firstChild);
    return result;
  };
  Utility.clone = function clone(b) {
    var a;
    if (typeof b === 'object') {
      a = b instanceof Array ? [] : {};
      for (var key in b) {
        if (typeof b[key] === 'object' && b[key] !== null) {
          if (b[key] instanceof Array) {
            a[key] = new Array(b[key].length);
            for (var i = 0; i < b[key].length; i++) {
              a[key][i] = Utility.clone(b[key][i]);
            }
          } else {
            a[key] = Utility.clone(b[key]);
          }
        } else {
          a[key] = b[key];
        }
      }
    } else {
      a = b;
    }
    return a;
  };
  module.exports = Utility;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/transitions/TweenTransition", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  function TweenTransition(options) {
    this.options = Object.create(TweenTransition.DEFAULT_OPTIONS);
    if (options)
      this.setOptions(options);
    this._startTime = 0;
    this._startValue = 0;
    this._updateTime = 0;
    this._endValue = 0;
    this._curve = undefined;
    this._duration = 0;
    this._active = false;
    this._callback = undefined;
    this.state = 0;
    this.velocity = undefined;
  }
  TweenTransition.Curves = {
    linear: function(t) {
      return t;
    },
    easeIn: function(t) {
      return t * t;
    },
    easeOut: function(t) {
      return t * (2 - t);
    },
    easeInOut: function(t) {
      if (t <= 0.5)
        return 2 * t * t;
      else
        return -2 * t * t + 4 * t - 1;
    },
    easeOutBounce: function(t) {
      return t * (3 - 2 * t);
    },
    spring: function(t) {
      return (1 - t) * Math.sin(6 * Math.PI * t) + t;
    }
  };
  TweenTransition.SUPPORTS_MULTIPLE = true;
  TweenTransition.DEFAULT_OPTIONS = {
    curve: TweenTransition.Curves.linear,
    duration: 500,
    speed: 0
  };
  var registeredCurves = {};
  TweenTransition.registerCurve = function registerCurve(curveName, curve) {
    if (!registeredCurves[curveName]) {
      registeredCurves[curveName] = curve;
      return true;
    } else {
      return false;
    }
  };
  TweenTransition.unregisterCurve = function unregisterCurve(curveName) {
    if (registeredCurves[curveName]) {
      delete registeredCurves[curveName];
      return true;
    } else {
      return false;
    }
  };
  TweenTransition.getCurve = function getCurve(curveName) {
    var curve = registeredCurves[curveName];
    if (curve !== undefined)
      return curve;
    else
      throw new Error('curve not registered');
  };
  TweenTransition.getCurves = function getCurves() {
    return registeredCurves;
  };
  function _interpolate(a, b, t) {
    return (1 - t) * a + t * b;
  }
  function _clone(obj) {
    if (obj instanceof Object) {
      if (obj instanceof Array)
        return obj.slice(0);
      else
        return Object.create(obj);
    } else
      return obj;
  }
  function _normalize(transition, defaultTransition) {
    var result = {curve: defaultTransition.curve};
    if (defaultTransition.duration)
      result.duration = defaultTransition.duration;
    if (defaultTransition.speed)
      result.speed = defaultTransition.speed;
    if (transition instanceof Object) {
      if (transition.duration !== undefined)
        result.duration = transition.duration;
      if (transition.curve)
        result.curve = transition.curve;
      if (transition.speed)
        result.speed = transition.speed;
    }
    if (typeof result.curve === 'string')
      result.curve = TweenTransition.getCurve(result.curve);
    return result;
  }
  TweenTransition.prototype.setOptions = function setOptions(options) {
    if (options.curve !== undefined)
      this.options.curve = options.curve;
    if (options.duration !== undefined)
      this.options.duration = options.duration;
    if (options.speed !== undefined)
      this.options.speed = options.speed;
  };
  TweenTransition.prototype.set = function set(endValue, transition, callback) {
    if (!transition) {
      this.reset(endValue);
      if (callback)
        callback();
      return ;
    }
    this._startValue = _clone(this.get());
    transition = _normalize(transition, this.options);
    if (transition.speed) {
      var startValue = this._startValue;
      if (startValue instanceof Object) {
        var variance = 0;
        for (var i in startValue)
          variance += (endValue[i] - startValue[i]) * (endValue[i] - startValue[i]);
        transition.duration = Math.sqrt(variance) / transition.speed;
      } else {
        transition.duration = Math.abs(endValue - startValue) / transition.speed;
      }
    }
    this._startTime = Date.now();
    this._endValue = _clone(endValue);
    this._startVelocity = _clone(transition.velocity);
    this._duration = transition.duration;
    this._curve = transition.curve;
    this._active = true;
    this._callback = callback;
  };
  TweenTransition.prototype.reset = function reset(startValue, startVelocity) {
    if (this._callback) {
      var callback = this._callback;
      this._callback = undefined;
      callback();
    }
    this.state = _clone(startValue);
    this.velocity = _clone(startVelocity);
    this._startTime = 0;
    this._duration = 0;
    this._updateTime = 0;
    this._startValue = this.state;
    this._startVelocity = this.velocity;
    this._endValue = this.state;
    this._active = false;
  };
  TweenTransition.prototype.getVelocity = function getVelocity() {
    return this.velocity;
  };
  TweenTransition.prototype.get = function get(timestamp) {
    this.update(timestamp);
    return this.state;
  };
  function _calculateVelocity(current, start, curve, duration, t) {
    var velocity;
    var eps = 1e-7;
    var speed = (curve(t) - curve(t - eps)) / eps;
    if (current instanceof Array) {
      velocity = [];
      for (var i = 0; i < current.length; i++) {
        if (typeof current[i] === 'number')
          velocity[i] = speed * (current[i] - start[i]) / duration;
        else
          velocity[i] = 0;
      }
    } else
      velocity = speed * (current - start) / duration;
    return velocity;
  }
  function _calculateState(start, end, t) {
    var state;
    if (start instanceof Array) {
      state = [];
      for (var i = 0; i < start.length; i++) {
        if (typeof start[i] === 'number')
          state[i] = _interpolate(start[i], end[i], t);
        else
          state[i] = start[i];
      }
    } else
      state = _interpolate(start, end, t);
    return state;
  }
  TweenTransition.prototype.update = function update(timestamp) {
    if (!this._active) {
      if (this._callback) {
        var callback = this._callback;
        this._callback = undefined;
        callback();
      }
      return ;
    }
    if (!timestamp)
      timestamp = Date.now();
    if (this._updateTime >= timestamp)
      return ;
    this._updateTime = timestamp;
    var timeSinceStart = timestamp - this._startTime;
    if (timeSinceStart >= this._duration) {
      this.state = this._endValue;
      this.velocity = _calculateVelocity(this.state, this._startValue, this._curve, this._duration, 1);
      this._active = false;
    } else if (timeSinceStart < 0) {
      this.state = this._startValue;
      this.velocity = this._startVelocity;
    } else {
      var t = timeSinceStart / this._duration;
      this.state = _calculateState(this._startValue, this._endValue, this._curve(t));
      this.velocity = _calculateVelocity(this.state, this._startValue, this._curve, this._duration, t);
    }
  };
  TweenTransition.prototype.isActive = function isActive() {
    return this._active;
  };
  TweenTransition.prototype.halt = function halt() {
    this.reset(this.get());
  };
  TweenTransition.registerCurve('linear', TweenTransition.Curves.linear);
  TweenTransition.registerCurve('easeIn', TweenTransition.Curves.easeIn);
  TweenTransition.registerCurve('easeOut', TweenTransition.Curves.easeOut);
  TweenTransition.registerCurve('easeInOut', TweenTransition.Curves.easeInOut);
  TweenTransition.registerCurve('easeOutBounce', TweenTransition.Curves.easeOutBounce);
  TweenTransition.registerCurve('spring', TweenTransition.Curves.spring);
  TweenTransition.customCurve = function customCurve(v1, v2) {
    v1 = v1 || 0;
    v2 = v2 || 0;
    return function(t) {
      return v1 * t + (-2 * v1 - v2 + 3) * t * t + (v1 + v2 - 2) * t * t * t;
    };
  };
  module.exports = TweenTransition;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/core/ElementOutput", ["npm:famous@0.3.5/core/Entity", "npm:famous@0.3.5/core/EventHandler", "npm:famous@0.3.5/core/Transform"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var Entity = require("npm:famous@0.3.5/core/Entity");
  var EventHandler = require("npm:famous@0.3.5/core/EventHandler");
  var Transform = require("npm:famous@0.3.5/core/Transform");
  var usePrefix = !('transform' in document.documentElement.style);
  var devicePixelRatio = window.devicePixelRatio || 1;
  function ElementOutput(element) {
    this._matrix = null;
    this._opacity = 1;
    this._origin = null;
    this._size = null;
    this._eventOutput = new EventHandler();
    this._eventOutput.bindThis(this);
    this.eventForwarder = function eventForwarder(event) {
      this._eventOutput.emit(event.type, event);
    }.bind(this);
    this.id = Entity.register(this);
    this._element = null;
    this._sizeDirty = false;
    this._originDirty = false;
    this._transformDirty = false;
    this._invisible = false;
    if (element)
      this.attach(element);
  }
  ElementOutput.prototype.on = function on(type, fn) {
    if (this._element)
      this._element.addEventListener(type, this.eventForwarder);
    this._eventOutput.on(type, fn);
  };
  ElementOutput.prototype.removeListener = function removeListener(type, fn) {
    this._eventOutput.removeListener(type, fn);
  };
  ElementOutput.prototype.emit = function emit(type, event) {
    if (event && !event.origin)
      event.origin = this;
    var handled = this._eventOutput.emit(type, event);
    if (handled && event && event.stopPropagation)
      event.stopPropagation();
    return handled;
  };
  ElementOutput.prototype.pipe = function pipe(target) {
    return this._eventOutput.pipe(target);
  };
  ElementOutput.prototype.unpipe = function unpipe(target) {
    return this._eventOutput.unpipe(target);
  };
  ElementOutput.prototype.render = function render() {
    return this.id;
  };
  function _addEventListeners(target) {
    for (var i in this._eventOutput.listeners) {
      target.addEventListener(i, this.eventForwarder);
    }
  }
  function _removeEventListeners(target) {
    for (var i in this._eventOutput.listeners) {
      target.removeEventListener(i, this.eventForwarder);
    }
  }
  function _formatCSSTransform(m) {
    m[12] = Math.round(m[12] * devicePixelRatio) / devicePixelRatio;
    m[13] = Math.round(m[13] * devicePixelRatio) / devicePixelRatio;
    var result = 'matrix3d(';
    for (var i = 0; i < 15; i++) {
      result += m[i] < 0.000001 && m[i] > -0.000001 ? '0,' : m[i] + ',';
    }
    result += m[15] + ')';
    return result;
  }
  var _setMatrix;
  if (usePrefix) {
    _setMatrix = function(element, matrix) {
      element.style.webkitTransform = _formatCSSTransform(matrix);
    };
  } else {
    _setMatrix = function(element, matrix) {
      element.style.transform = _formatCSSTransform(matrix);
    };
  }
  function _formatCSSOrigin(origin) {
    return 100 * origin[0] + '% ' + 100 * origin[1] + '%';
  }
  var _setOrigin = usePrefix ? function(element, origin) {
    element.style.webkitTransformOrigin = _formatCSSOrigin(origin);
  } : function(element, origin) {
    element.style.transformOrigin = _formatCSSOrigin(origin);
  };
  var _setInvisible = usePrefix ? function(element) {
    element.style.webkitTransform = 'scale3d(0.0001,0.0001,0.0001)';
    element.style.opacity = 0;
  } : function(element) {
    element.style.transform = 'scale3d(0.0001,0.0001,0.0001)';
    element.style.opacity = 0;
  };
  function _xyNotEquals(a, b) {
    return a && b ? a[0] !== b[0] || a[1] !== b[1] : a !== b;
  }
  ElementOutput.prototype.commit = function commit(context) {
    var target = this._element;
    if (!target)
      return ;
    var matrix = context.transform;
    var opacity = context.opacity;
    var origin = context.origin;
    var size = context.size;
    if (!matrix && this._matrix) {
      this._matrix = null;
      this._opacity = 0;
      _setInvisible(target);
      return ;
    }
    if (_xyNotEquals(this._origin, origin))
      this._originDirty = true;
    if (Transform.notEquals(this._matrix, matrix))
      this._transformDirty = true;
    if (this._invisible) {
      this._invisible = false;
      this._element.style.display = '';
    }
    if (this._opacity !== opacity) {
      this._opacity = opacity;
      target.style.opacity = opacity >= 1 ? '0.999999' : opacity;
    }
    if (this._transformDirty || this._originDirty || this._sizeDirty) {
      if (this._sizeDirty)
        this._sizeDirty = false;
      if (this._originDirty) {
        if (origin) {
          if (!this._origin)
            this._origin = [0, 0];
          this._origin[0] = origin[0];
          this._origin[1] = origin[1];
        } else
          this._origin = null;
        _setOrigin(target, this._origin);
        this._originDirty = false;
      }
      if (!matrix)
        matrix = Transform.identity;
      this._matrix = matrix;
      var aaMatrix = this._size ? Transform.thenMove(matrix, [-this._size[0] * origin[0], -this._size[1] * origin[1], 0]) : matrix;
      _setMatrix(target, aaMatrix);
      this._transformDirty = false;
    }
  };
  ElementOutput.prototype.cleanup = function cleanup() {
    if (this._element) {
      this._invisible = true;
      this._element.style.display = 'none';
    }
  };
  ElementOutput.prototype.attach = function attach(target) {
    this._element = target;
    _addEventListeners.call(this, target);
  };
  ElementOutput.prototype.detach = function detach() {
    var target = this._element;
    if (target) {
      _removeEventListeners.call(this, target);
      if (this._invisible) {
        this._invisible = false;
        this._element.style.display = '';
      }
    }
    this._element = null;
    return target;
  };
  module.exports = ElementOutput;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/core/OptionsManager", ["npm:famous@0.3.5/core/EventHandler"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var EventHandler = require("npm:famous@0.3.5/core/EventHandler");
  function OptionsManager(value) {
    this._value = value;
    this.eventOutput = null;
  }
  OptionsManager.patch = function patchObject(source, data) {
    var manager = new OptionsManager(source);
    for (var i = 1; i < arguments.length; i++)
      manager.patch(arguments[i]);
    return source;
  };
  function _createEventOutput() {
    this.eventOutput = new EventHandler();
    this.eventOutput.bindThis(this);
    EventHandler.setOutputHandler(this, this.eventOutput);
  }
  OptionsManager.prototype.patch = function patch() {
    var myState = this._value;
    for (var i = 0; i < arguments.length; i++) {
      var data = arguments[i];
      for (var k in data) {
        if (k in myState && (data[k] && data[k].constructor === Object) && (myState[k] && myState[k].constructor === Object)) {
          if (!myState.hasOwnProperty(k))
            myState[k] = Object.create(myState[k]);
          this.key(k).patch(data[k]);
          if (this.eventOutput)
            this.eventOutput.emit('change', {
              id: k,
              value: this.key(k).value()
            });
        } else
          this.set(k, data[k]);
      }
    }
    return this;
  };
  OptionsManager.prototype.setOptions = OptionsManager.prototype.patch;
  OptionsManager.prototype.key = function key(identifier) {
    var result = new OptionsManager(this._value[identifier]);
    if (!(result._value instanceof Object) || result._value instanceof Array)
      result._value = {};
    return result;
  };
  OptionsManager.prototype.get = function get(key) {
    return key ? this._value[key] : this._value;
  };
  OptionsManager.prototype.getOptions = OptionsManager.prototype.get;
  OptionsManager.prototype.set = function set(key, value) {
    var originalValue = this.get(key);
    this._value[key] = value;
    if (this.eventOutput && value !== originalValue)
      this.eventOutput.emit('change', {
        id: key,
        value: value
      });
    return this;
  };
  OptionsManager.prototype.on = function on() {
    _createEventOutput.call(this);
    return this.on.apply(this, arguments);
  };
  OptionsManager.prototype.removeListener = function removeListener() {
    _createEventOutput.call(this);
    return this.removeListener.apply(this, arguments);
  };
  OptionsManager.prototype.pipe = function pipe() {
    _createEventOutput.call(this);
    return this.pipe.apply(this, arguments);
  };
  OptionsManager.prototype.unpipe = function unpipe() {
    _createEventOutput.call(this);
    return this.unpipe.apply(this, arguments);
  };
  module.exports = OptionsManager;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/core/Surface", ["npm:famous@0.3.5/core/ElementOutput"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var ElementOutput = require("npm:famous@0.3.5/core/ElementOutput");
  function Surface(options) {
    ElementOutput.call(this);
    this.options = {};
    this.properties = {};
    this.attributes = {};
    this.content = '';
    this.classList = [];
    this.size = null;
    this._classesDirty = true;
    this._stylesDirty = true;
    this._attributesDirty = true;
    this._sizeDirty = true;
    this._contentDirty = true;
    this._trueSizeCheck = true;
    this._dirtyClasses = [];
    if (options)
      this.setOptions(options);
    this._currentTarget = null;
  }
  Surface.prototype = Object.create(ElementOutput.prototype);
  Surface.prototype.constructor = Surface;
  Surface.prototype.elementType = 'div';
  Surface.prototype.elementClass = 'famous-surface';
  Surface.prototype.setAttributes = function setAttributes(attributes) {
    for (var n in attributes) {
      if (n === 'style')
        throw new Error('Cannot set styles via "setAttributes" as it will break Famo.us.  Use "setProperties" instead.');
      this.attributes[n] = attributes[n];
    }
    this._attributesDirty = true;
  };
  Surface.prototype.getAttributes = function getAttributes() {
    return this.attributes;
  };
  Surface.prototype.setProperties = function setProperties(properties) {
    for (var n in properties) {
      this.properties[n] = properties[n];
    }
    this._stylesDirty = true;
    return this;
  };
  Surface.prototype.getProperties = function getProperties() {
    return this.properties;
  };
  Surface.prototype.addClass = function addClass(className) {
    if (this.classList.indexOf(className) < 0) {
      this.classList.push(className);
      this._classesDirty = true;
    }
    return this;
  };
  Surface.prototype.removeClass = function removeClass(className) {
    var i = this.classList.indexOf(className);
    if (i >= 0) {
      this._dirtyClasses.push(this.classList.splice(i, 1)[0]);
      this._classesDirty = true;
    }
    return this;
  };
  Surface.prototype.toggleClass = function toggleClass(className) {
    var i = this.classList.indexOf(className);
    if (i >= 0) {
      this.removeClass(className);
    } else {
      this.addClass(className);
    }
    return this;
  };
  Surface.prototype.setClasses = function setClasses(classList) {
    var i = 0;
    var removal = [];
    for (i = 0; i < this.classList.length; i++) {
      if (classList.indexOf(this.classList[i]) < 0)
        removal.push(this.classList[i]);
    }
    for (i = 0; i < removal.length; i++)
      this.removeClass(removal[i]);
    for (i = 0; i < classList.length; i++)
      this.addClass(classList[i]);
    return this;
  };
  Surface.prototype.getClassList = function getClassList() {
    return this.classList;
  };
  Surface.prototype.setContent = function setContent(content) {
    if (this.content !== content) {
      this.content = content;
      this._contentDirty = true;
    }
    return this;
  };
  Surface.prototype.getContent = function getContent() {
    return this.content;
  };
  Surface.prototype.setOptions = function setOptions(options) {
    if (options.size)
      this.setSize(options.size);
    if (options.classes)
      this.setClasses(options.classes);
    if (options.properties)
      this.setProperties(options.properties);
    if (options.attributes)
      this.setAttributes(options.attributes);
    if (options.content)
      this.setContent(options.content);
    return this;
  };
  function _cleanupClasses(target) {
    for (var i = 0; i < this._dirtyClasses.length; i++)
      target.classList.remove(this._dirtyClasses[i]);
    this._dirtyClasses = [];
  }
  function _applyStyles(target) {
    for (var n in this.properties) {
      target.style[n] = this.properties[n];
    }
  }
  function _cleanupStyles(target) {
    for (var n in this.properties) {
      target.style[n] = '';
    }
  }
  function _applyAttributes(target) {
    for (var n in this.attributes) {
      target.setAttribute(n, this.attributes[n]);
    }
  }
  function _cleanupAttributes(target) {
    for (var n in this.attributes) {
      target.removeAttribute(n);
    }
  }
  function _xyNotEquals(a, b) {
    return a && b ? a[0] !== b[0] || a[1] !== b[1] : a !== b;
  }
  Surface.prototype.setup = function setup(allocator) {
    var target = allocator.allocate(this.elementType);
    if (this.elementClass) {
      if (this.elementClass instanceof Array) {
        for (var i = 0; i < this.elementClass.length; i++) {
          target.classList.add(this.elementClass[i]);
        }
      } else {
        target.classList.add(this.elementClass);
      }
    }
    target.style.display = '';
    this.attach(target);
    this._opacity = null;
    this._currentTarget = target;
    this._stylesDirty = true;
    this._classesDirty = true;
    this._attributesDirty = true;
    this._sizeDirty = true;
    this._contentDirty = true;
    this._originDirty = true;
    this._transformDirty = true;
  };
  Surface.prototype.commit = function commit(context) {
    if (!this._currentTarget)
      this.setup(context.allocator);
    var target = this._currentTarget;
    var size = context.size;
    if (this._classesDirty) {
      _cleanupClasses.call(this, target);
      var classList = this.getClassList();
      for (var i = 0; i < classList.length; i++)
        target.classList.add(classList[i]);
      this._classesDirty = false;
      this._trueSizeCheck = true;
    }
    if (this._stylesDirty) {
      _applyStyles.call(this, target);
      this._stylesDirty = false;
      this._trueSizeCheck = true;
    }
    if (this._attributesDirty) {
      _applyAttributes.call(this, target);
      this._attributesDirty = false;
      this._trueSizeCheck = true;
    }
    if (this.size) {
      var origSize = context.size;
      size = [this.size[0], this.size[1]];
      if (size[0] === undefined)
        size[0] = origSize[0];
      if (size[1] === undefined)
        size[1] = origSize[1];
      if (size[0] === true || size[1] === true) {
        if (size[0] === true) {
          if (this._trueSizeCheck || this._size[0] === 0) {
            var width = target.offsetWidth;
            if (this._size && this._size[0] !== width) {
              this._size[0] = width;
              this._sizeDirty = true;
            }
            size[0] = width;
          } else {
            if (this._size)
              size[0] = this._size[0];
          }
        }
        if (size[1] === true) {
          if (this._trueSizeCheck || this._size[1] === 0) {
            var height = target.offsetHeight;
            if (this._size && this._size[1] !== height) {
              this._size[1] = height;
              this._sizeDirty = true;
            }
            size[1] = height;
          } else {
            if (this._size)
              size[1] = this._size[1];
          }
        }
        this._trueSizeCheck = false;
      }
    }
    if (_xyNotEquals(this._size, size)) {
      if (!this._size)
        this._size = [0, 0];
      this._size[0] = size[0];
      this._size[1] = size[1];
      this._sizeDirty = true;
    }
    if (this._sizeDirty) {
      if (this._size) {
        target.style.width = this.size && this.size[0] === true ? '' : this._size[0] + 'px';
        target.style.height = this.size && this.size[1] === true ? '' : this._size[1] + 'px';
      }
      this._eventOutput.emit('resize');
    }
    if (this._contentDirty) {
      this.deploy(target);
      this._eventOutput.emit('deploy');
      this._contentDirty = false;
      this._trueSizeCheck = true;
    }
    ElementOutput.prototype.commit.call(this, context);
  };
  Surface.prototype.cleanup = function cleanup(allocator) {
    var i = 0;
    var target = this._currentTarget;
    this._eventOutput.emit('recall');
    this.recall(target);
    target.style.display = 'none';
    target.style.opacity = '';
    target.style.width = '';
    target.style.height = '';
    _cleanupStyles.call(this, target);
    _cleanupAttributes.call(this, target);
    var classList = this.getClassList();
    _cleanupClasses.call(this, target);
    for (i = 0; i < classList.length; i++)
      target.classList.remove(classList[i]);
    if (this.elementClass) {
      if (this.elementClass instanceof Array) {
        for (i = 0; i < this.elementClass.length; i++) {
          target.classList.remove(this.elementClass[i]);
        }
      } else {
        target.classList.remove(this.elementClass);
      }
    }
    this.detach(target);
    this._currentTarget = null;
    allocator.deallocate(target);
  };
  Surface.prototype.deploy = function deploy(target) {
    var content = this.getContent();
    if (content instanceof Node) {
      while (target.hasChildNodes())
        target.removeChild(target.firstChild);
      target.appendChild(content);
    } else
      target.innerHTML = content;
  };
  Surface.prototype.recall = function recall(target) {
    var df = document.createDocumentFragment();
    while (target.hasChildNodes())
      df.appendChild(target.firstChild);
    this.setContent(df);
  };
  Surface.prototype.getSize = function getSize() {
    return this._size ? this._size : this.size;
  };
  Surface.prototype.setSize = function setSize(size) {
    this.size = size ? [size[0], size[1]] : null;
    this._sizeDirty = true;
    return this;
  };
  module.exports = Surface;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/transitions/TransitionableTransform", ["npm:famous@0.3.5/transitions/Transitionable", "npm:famous@0.3.5/core/Transform", "npm:famous@0.3.5/utilities/Utility"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var Transitionable = require("npm:famous@0.3.5/transitions/Transitionable");
  var Transform = require("npm:famous@0.3.5/core/Transform");
  var Utility = require("npm:famous@0.3.5/utilities/Utility");
  function TransitionableTransform(transform) {
    this._final = Transform.identity.slice();
    this._finalTranslate = [0, 0, 0];
    this._finalRotate = [0, 0, 0];
    this._finalSkew = [0, 0, 0];
    this._finalScale = [1, 1, 1];
    this.translate = new Transitionable(this._finalTranslate);
    this.rotate = new Transitionable(this._finalRotate);
    this.skew = new Transitionable(this._finalSkew);
    this.scale = new Transitionable(this._finalScale);
    if (transform)
      this.set(transform);
  }
  function _build() {
    return Transform.build({
      translate: this.translate.get(),
      rotate: this.rotate.get(),
      skew: this.skew.get(),
      scale: this.scale.get()
    });
  }
  function _buildFinal() {
    return Transform.build({
      translate: this._finalTranslate,
      rotate: this._finalRotate,
      skew: this._finalSkew,
      scale: this._finalScale
    });
  }
  TransitionableTransform.prototype.setTranslate = function setTranslate(translate, transition, callback) {
    this._finalTranslate = translate;
    this._final = _buildFinal.call(this);
    this.translate.set(translate, transition, callback);
    return this;
  };
  TransitionableTransform.prototype.setScale = function setScale(scale, transition, callback) {
    this._finalScale = scale;
    this._final = _buildFinal.call(this);
    this.scale.set(scale, transition, callback);
    return this;
  };
  TransitionableTransform.prototype.setRotate = function setRotate(eulerAngles, transition, callback) {
    this._finalRotate = eulerAngles;
    this._final = _buildFinal.call(this);
    this.rotate.set(eulerAngles, transition, callback);
    return this;
  };
  TransitionableTransform.prototype.setSkew = function setSkew(skewAngles, transition, callback) {
    this._finalSkew = skewAngles;
    this._final = _buildFinal.call(this);
    this.skew.set(skewAngles, transition, callback);
    return this;
  };
  TransitionableTransform.prototype.set = function set(transform, transition, callback) {
    var components = Transform.interpret(transform);
    this._finalTranslate = components.translate;
    this._finalRotate = components.rotate;
    this._finalSkew = components.skew;
    this._finalScale = components.scale;
    this._final = transform;
    var _callback = callback ? Utility.after(4, callback) : null;
    this.translate.set(components.translate, transition, _callback);
    this.rotate.set(components.rotate, transition, _callback);
    this.skew.set(components.skew, transition, _callback);
    this.scale.set(components.scale, transition, _callback);
    return this;
  };
  TransitionableTransform.prototype.setDefaultTransition = function setDefaultTransition(transition) {
    this.translate.setDefault(transition);
    this.rotate.setDefault(transition);
    this.skew.setDefault(transition);
    this.scale.setDefault(transition);
  };
  TransitionableTransform.prototype.get = function get() {
    if (this.isActive()) {
      return _build.call(this);
    } else
      return this._final;
  };
  TransitionableTransform.prototype.getFinal = function getFinal() {
    return this._final;
  };
  TransitionableTransform.prototype.isActive = function isActive() {
    return this.translate.isActive() || this.rotate.isActive() || this.scale.isActive() || this.skew.isActive();
  };
  TransitionableTransform.prototype.halt = function halt() {
    this.translate.halt();
    this.rotate.halt();
    this.skew.halt();
    this.scale.halt();
    this._final = this.get();
    this._finalTranslate = this.translate.get();
    this._finalRotate = this.rotate.get();
    this._finalSkew = this.skew.get();
    this._finalScale = this.scale.get();
    return this;
  };
  module.exports = TransitionableTransform;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/core/Scene", ["npm:famous@0.3.5/core/Transform", "npm:famous@0.3.5/core/Modifier", "npm:famous@0.3.5/core/RenderNode"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var Transform = require("npm:famous@0.3.5/core/Transform");
  var Modifier = require("npm:famous@0.3.5/core/Modifier");
  var RenderNode = require("npm:famous@0.3.5/core/RenderNode");
  function Scene(definition) {
    this.id = null;
    this._objects = null;
    this.node = new RenderNode();
    this._definition = null;
    if (definition)
      this.load(definition);
  }
  var _MATRIX_GENERATORS = {
    'translate': Transform.translate,
    'rotate': Transform.rotate,
    'rotateX': Transform.rotateX,
    'rotateY': Transform.rotateY,
    'rotateZ': Transform.rotateZ,
    'rotateAxis': Transform.rotateAxis,
    'scale': Transform.scale,
    'skew': Transform.skew,
    'matrix3d': function() {
      return arguments;
    }
  };
  Scene.prototype.create = function create() {
    return new Scene(this._definition);
  };
  function _resolveTransformMatrix(matrixDefinition) {
    for (var type in _MATRIX_GENERATORS) {
      if (type in matrixDefinition) {
        var args = matrixDefinition[type];
        if (!(args instanceof Array))
          args = [args];
        return _MATRIX_GENERATORS[type].apply(this, args);
      }
    }
  }
  function _parseTransform(definition) {
    var transformDefinition = definition.transform;
    var opacity = definition.opacity;
    var origin = definition.origin;
    var align = definition.align;
    var size = definition.size;
    var transform = Transform.identity;
    if (transformDefinition instanceof Array) {
      if (transformDefinition.length === 16 && typeof transformDefinition[0] === 'number') {
        transform = transformDefinition;
      } else {
        for (var i = 0; i < transformDefinition.length; i++) {
          transform = Transform.multiply(transform, _resolveTransformMatrix(transformDefinition[i]));
        }
      }
    } else if (transformDefinition instanceof Function) {
      transform = transformDefinition;
    } else if (transformDefinition instanceof Object) {
      transform = _resolveTransformMatrix(transformDefinition);
    }
    var result = new Modifier({
      transform: transform,
      opacity: opacity,
      origin: origin,
      align: align,
      size: size
    });
    return result;
  }
  function _parseArray(definition) {
    var result = new RenderNode();
    for (var i = 0; i < definition.length; i++) {
      var obj = _parse.call(this, definition[i]);
      if (obj)
        result.add(obj);
    }
    return result;
  }
  function _parse(definition) {
    var result;
    var id;
    if (definition instanceof Array) {
      result = _parseArray.call(this, definition);
    } else {
      id = this._objects.length;
      if (definition.render && definition.render instanceof Function) {
        result = definition;
      } else if (definition.target) {
        var targetObj = _parse.call(this, definition.target);
        var obj = _parseTransform.call(this, definition);
        result = new RenderNode(obj);
        result.add(targetObj);
        if (definition.id)
          this.id[definition.id] = obj;
      } else if (definition.id) {
        result = new RenderNode();
        this.id[definition.id] = result;
      }
    }
    this._objects[id] = result;
    return result;
  }
  Scene.prototype.load = function load(definition) {
    this._definition = definition;
    this.id = {};
    this._objects = [];
    this.node.set(_parse.call(this, definition));
  };
  Scene.prototype.add = function add() {
    return this.node.add.apply(this.node, arguments);
  };
  Scene.prototype.render = function render() {
    return this.node.render.apply(this.node, arguments);
  };
  module.exports = Scene;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/core/View", ["npm:famous@0.3.5/core/EventHandler", "npm:famous@0.3.5/core/OptionsManager", "npm:famous@0.3.5/core/RenderNode", "npm:famous@0.3.5/utilities/Utility"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var EventHandler = require("npm:famous@0.3.5/core/EventHandler");
  var OptionsManager = require("npm:famous@0.3.5/core/OptionsManager");
  var RenderNode = require("npm:famous@0.3.5/core/RenderNode");
  var Utility = require("npm:famous@0.3.5/utilities/Utility");
  function View(options) {
    this._node = new RenderNode();
    this._eventInput = new EventHandler();
    this._eventOutput = new EventHandler();
    EventHandler.setInputHandler(this, this._eventInput);
    EventHandler.setOutputHandler(this, this._eventOutput);
    this.options = Utility.clone(this.constructor.DEFAULT_OPTIONS || View.DEFAULT_OPTIONS);
    this._optionsManager = new OptionsManager(this.options);
    if (options)
      this.setOptions(options);
  }
  View.DEFAULT_OPTIONS = {};
  View.prototype.getOptions = function getOptions(key) {
    return this._optionsManager.getOptions(key);
  };
  View.prototype.setOptions = function setOptions(options) {
    this._optionsManager.patch(options);
  };
  View.prototype.add = function add() {
    return this._node.add.apply(this._node, arguments);
  };
  View.prototype._add = View.prototype.add;
  View.prototype.render = function render() {
    return this._node.render();
  };
  View.prototype.getSize = function getSize() {
    if (this._node && this._node.getSize) {
      return this._node.getSize.apply(this._node, arguments) || this.options.size;
    } else
      return this.options.size;
  };
  module.exports = View;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/core/ViewSequence", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  function ViewSequence(options) {
    if (!options)
      options = [];
    if (options instanceof Array)
      options = {array: options};
    this._ = null;
    this.index = options.index || 0;
    if (options.array)
      this._ = new this.constructor.Backing(options.array);
    else if (options._)
      this._ = options._;
    if (this.index === this._.firstIndex)
      this._.firstNode = this;
    if (this.index === this._.firstIndex + this._.array.length - 1)
      this._.lastNode = this;
    if (options.loop !== undefined)
      this._.loop = options.loop;
    if (options.trackSize !== undefined)
      this._.trackSize = options.trackSize;
    this._previousNode = null;
    this._nextNode = null;
  }
  ViewSequence.Backing = function Backing(array) {
    this.array = array;
    this.firstIndex = 0;
    this.loop = false;
    this.firstNode = null;
    this.lastNode = null;
    this.cumulativeSizes = [[0, 0]];
    this.sizeDirty = true;
    this.trackSize = false;
  };
  ViewSequence.Backing.prototype.getValue = function getValue(i) {
    var _i = i - this.firstIndex;
    if (_i < 0 || _i >= this.array.length)
      return null;
    return this.array[_i];
  };
  ViewSequence.Backing.prototype.setValue = function setValue(i, value) {
    this.array[i - this.firstIndex] = value;
  };
  ViewSequence.Backing.prototype.getSize = function getSize(index) {
    return this.cumulativeSizes[index];
  };
  ViewSequence.Backing.prototype.calculateSize = function calculateSize(index) {
    index = index || this.array.length;
    var size = [0, 0];
    for (var i = 0; i < index; i++) {
      var nodeSize = this.array[i].getSize();
      if (!nodeSize)
        return undefined;
      if (size[0] !== undefined) {
        if (nodeSize[0] === undefined)
          size[0] = undefined;
        else
          size[0] += nodeSize[0];
      }
      if (size[1] !== undefined) {
        if (nodeSize[1] === undefined)
          size[1] = undefined;
        else
          size[1] += nodeSize[1];
      }
      this.cumulativeSizes[i + 1] = size.slice();
    }
    this.sizeDirty = false;
    return size;
  };
  ViewSequence.Backing.prototype.reindex = function reindex(start, removeCount, insertCount) {
    if (!this.array[0])
      return ;
    var i = 0;
    var index = this.firstIndex;
    var indexShiftAmount = insertCount - removeCount;
    var node = this.firstNode;
    while (index < start - 1) {
      node = node.getNext();
      index++;
    }
    var spliceStartNode = node;
    for (i = 0; i < removeCount; i++) {
      node = node.getNext();
      if (node)
        node._previousNode = spliceStartNode;
    }
    var spliceResumeNode = node ? node.getNext() : null;
    spliceStartNode._nextNode = null;
    node = spliceStartNode;
    for (i = 0; i < insertCount; i++)
      node = node.getNext();
    index += insertCount;
    if (node !== spliceResumeNode) {
      node._nextNode = spliceResumeNode;
      if (spliceResumeNode)
        spliceResumeNode._previousNode = node;
    }
    if (spliceResumeNode) {
      node = spliceResumeNode;
      index++;
      while (node && index < this.array.length + this.firstIndex) {
        if (node._nextNode)
          node.index += indexShiftAmount;
        else
          node.index = index;
        node = node.getNext();
        index++;
      }
    }
    if (this.trackSize)
      this.sizeDirty = true;
  };
  ViewSequence.prototype.getPrevious = function getPrevious() {
    var len = this._.array.length;
    if (!len) {
      this._previousNode = null;
    } else if (this.index === this._.firstIndex) {
      if (this._.loop) {
        this._previousNode = this._.lastNode || new this.constructor({
          _: this._,
          index: this._.firstIndex + len - 1
        });
        this._previousNode._nextNode = this;
      } else {
        this._previousNode = null;
      }
    } else if (!this._previousNode) {
      this._previousNode = new this.constructor({
        _: this._,
        index: this.index - 1
      });
      this._previousNode._nextNode = this;
    }
    return this._previousNode;
  };
  ViewSequence.prototype.getNext = function getNext() {
    var len = this._.array.length;
    if (!len) {
      this._nextNode = null;
    } else if (this.index === this._.firstIndex + len - 1) {
      if (this._.loop) {
        this._nextNode = this._.firstNode || new this.constructor({
          _: this._,
          index: this._.firstIndex
        });
        this._nextNode._previousNode = this;
      } else {
        this._nextNode = null;
      }
    } else if (!this._nextNode) {
      this._nextNode = new this.constructor({
        _: this._,
        index: this.index + 1
      });
      this._nextNode._previousNode = this;
    }
    return this._nextNode;
  };
  ViewSequence.prototype.indexOf = function indexOf(item) {
    return this._.array.indexOf(item);
  };
  ViewSequence.prototype.getIndex = function getIndex() {
    return this.index;
  };
  ViewSequence.prototype.toString = function toString() {
    return '' + this.index;
  };
  ViewSequence.prototype.unshift = function unshift(value) {
    this._.array.unshift.apply(this._.array, arguments);
    this._.firstIndex -= arguments.length;
    if (this._.trackSize)
      this._.sizeDirty = true;
  };
  ViewSequence.prototype.push = function push(value) {
    this._.array.push.apply(this._.array, arguments);
    if (this._.trackSize)
      this._.sizeDirty = true;
  };
  ViewSequence.prototype.splice = function splice(index, howMany) {
    var values = Array.prototype.slice.call(arguments, 2);
    this._.array.splice.apply(this._.array, [index - this._.firstIndex, howMany].concat(values));
    this._.reindex(index, howMany, values.length);
  };
  ViewSequence.prototype.swap = function swap(other) {
    var otherValue = other.get();
    var myValue = this.get();
    this._.setValue(this.index, otherValue);
    this._.setValue(other.index, myValue);
    var myPrevious = this._previousNode;
    var myNext = this._nextNode;
    var myIndex = this.index;
    var otherPrevious = other._previousNode;
    var otherNext = other._nextNode;
    var otherIndex = other.index;
    this.index = otherIndex;
    this._previousNode = otherPrevious === this ? other : otherPrevious;
    if (this._previousNode)
      this._previousNode._nextNode = this;
    this._nextNode = otherNext === this ? other : otherNext;
    if (this._nextNode)
      this._nextNode._previousNode = this;
    other.index = myIndex;
    other._previousNode = myPrevious === other ? this : myPrevious;
    if (other._previousNode)
      other._previousNode._nextNode = other;
    other._nextNode = myNext === other ? this : myNext;
    if (other._nextNode)
      other._nextNode._previousNode = other;
    if (this.index === this._.firstIndex)
      this._.firstNode = this;
    else if (this.index === this._.firstIndex + this._.array.length - 1)
      this._.lastNode = this;
    if (other.index === this._.firstIndex)
      this._.firstNode = other;
    else if (other.index === this._.firstIndex + this._.array.length - 1)
      this._.lastNode = other;
    if (this._.trackSize)
      this._.sizeDirty = true;
  };
  ViewSequence.prototype.get = function get() {
    return this._.getValue(this.index);
  };
  ViewSequence.prototype.getSize = function getSize() {
    var target = this.get();
    return target ? target.getSize() : null;
  };
  ViewSequence.prototype.render = function render() {
    if (this._.trackSize && this._.sizeDirty)
      this._.calculateSize();
    var target = this.get();
    return target ? target.render.apply(target, arguments) : null;
  };
  module.exports = ViewSequence;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/events/EventArbiter", ["npm:famous@0.3.5/core/EventHandler"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var EventHandler = require("npm:famous@0.3.5/core/EventHandler");
  function EventArbiter(startMode) {
    this.dispatchers = {};
    this.currMode = undefined;
    this.setMode(startMode);
  }
  EventArbiter.prototype.setMode = function setMode(mode) {
    if (mode !== this.currMode) {
      var startMode = this.currMode;
      if (this.dispatchers[this.currMode])
        this.dispatchers[this.currMode].trigger('unpipe');
      this.currMode = mode;
      if (this.dispatchers[mode])
        this.dispatchers[mode].emit('pipe');
      this.emit('change', {
        from: startMode,
        to: mode
      });
    }
  };
  EventArbiter.prototype.forMode = function forMode(mode) {
    if (!this.dispatchers[mode])
      this.dispatchers[mode] = new EventHandler();
    return this.dispatchers[mode];
  };
  EventArbiter.prototype.emit = function emit(eventType, event) {
    if (this.currMode === undefined)
      return false;
    if (!event)
      event = {};
    var dispatcher = this.dispatchers[this.currMode];
    if (dispatcher)
      return dispatcher.trigger(eventType, event);
  };
  module.exports = EventArbiter;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/events/EventFilter", ["npm:famous@0.3.5/core/EventHandler"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var EventHandler = require("npm:famous@0.3.5/core/EventHandler");
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
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/events/EventMapper", ["npm:famous@0.3.5/core/EventHandler"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var EventHandler = require("npm:famous@0.3.5/core/EventHandler");
  function EventMapper(mappingFunction) {
    EventHandler.call(this);
    this._mappingFunction = mappingFunction;
  }
  EventMapper.prototype = Object.create(EventHandler.prototype);
  EventMapper.prototype.constructor = EventMapper;
  EventMapper.prototype.subscribe = null;
  EventMapper.prototype.unsubscribe = null;
  EventMapper.prototype.emit = function emit(type, data) {
    var target = this._mappingFunction.apply(this, arguments);
    if (target && target.emit instanceof Function)
      target.emit(type, data);
  };
  EventMapper.prototype.trigger = EventMapper.prototype.emit;
  module.exports = EventMapper;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/inputs/Accumulator", ["npm:famous@0.3.5/core/EventHandler", "npm:famous@0.3.5/transitions/Transitionable"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var EventHandler = require("npm:famous@0.3.5/core/EventHandler");
  var Transitionable = require("npm:famous@0.3.5/transitions/Transitionable");
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
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/inputs/DesktopEmulationMode", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  "format cjs";
  var hasTouch = 'ontouchstart' in window;
  function kill(type) {
    window.addEventListener(type, function(event) {
      event.stopPropagation();
      return false;
    }, true);
  }
  if (hasTouch) {
    kill('mousedown');
    kill('mousemove');
    kill('mouseup');
    kill('mouseleave');
  }
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/inputs/FastClick", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  "format cjs";
  (function() {
    if (!window.CustomEvent)
      return ;
    var clickThreshold = 300;
    var clickWindow = 500;
    var potentialClicks = {};
    var recentlyDispatched = {};
    var _now = Date.now;
    window.addEventListener('touchstart', function(event) {
      var timestamp = _now();
      for (var i = 0; i < event.changedTouches.length; i++) {
        var touch = event.changedTouches[i];
        potentialClicks[touch.identifier] = timestamp;
      }
    });
    window.addEventListener('touchmove', function(event) {
      for (var i = 0; i < event.changedTouches.length; i++) {
        var touch = event.changedTouches[i];
        delete potentialClicks[touch.identifier];
      }
    });
    window.addEventListener('touchend', function(event) {
      var currTime = _now();
      for (var i = 0; i < event.changedTouches.length; i++) {
        var touch = event.changedTouches[i];
        var startTime = potentialClicks[touch.identifier];
        if (startTime && currTime - startTime < clickThreshold) {
          var clickEvt = new window.CustomEvent('click', {
            'bubbles': true,
            'detail': touch
          });
          recentlyDispatched[currTime] = event;
          event.target.dispatchEvent(clickEvt);
        }
        delete potentialClicks[touch.identifier];
      }
    });
    window.addEventListener('click', function(event) {
      var currTime = _now();
      for (var i in recentlyDispatched) {
        var previousEvent = recentlyDispatched[i];
        if (currTime - i < clickWindow) {
          if (event instanceof window.MouseEvent && event.target === previousEvent.target)
            event.stopPropagation();
        } else
          delete recentlyDispatched[i];
      }
    }, true);
  }());
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/inputs/GenericSync", ["npm:famous@0.3.5/core/EventHandler"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var EventHandler = require("npm:famous@0.3.5/core/EventHandler");
  function GenericSync(syncs, options) {
    this._eventInput = new EventHandler();
    this._eventOutput = new EventHandler();
    EventHandler.setInputHandler(this, this._eventInput);
    EventHandler.setOutputHandler(this, this._eventOutput);
    this._syncs = {};
    if (syncs)
      this.addSync(syncs);
    if (options)
      this.setOptions(options);
  }
  GenericSync.DIRECTION_X = 0;
  GenericSync.DIRECTION_Y = 1;
  GenericSync.DIRECTION_Z = 2;
  var registry = {};
  GenericSync.register = function register(syncObject) {
    for (var key in syncObject) {
      if (registry[key]) {
        if (registry[key] !== syncObject[key])
          throw new Error('Conflicting sync classes for key: ' + key);
      } else
        registry[key] = syncObject[key];
    }
  };
  GenericSync.prototype.setOptions = function(options) {
    for (var key in this._syncs) {
      this._syncs[key].setOptions(options);
    }
  };
  GenericSync.prototype.pipeSync = function pipeToSync(key) {
    var sync = this._syncs[key];
    this._eventInput.pipe(sync);
    sync.pipe(this._eventOutput);
  };
  GenericSync.prototype.unpipeSync = function unpipeFromSync(key) {
    var sync = this._syncs[key];
    this._eventInput.unpipe(sync);
    sync.unpipe(this._eventOutput);
  };
  function _addSingleSync(key, options) {
    if (!registry[key])
      return ;
    this._syncs[key] = new registry[key](options);
    this.pipeSync(key);
  }
  GenericSync.prototype.addSync = function addSync(syncs) {
    if (syncs instanceof Array)
      for (var i = 0; i < syncs.length; i++)
        _addSingleSync.call(this, syncs[i]);
    else if (syncs instanceof Object)
      for (var key in syncs)
        _addSingleSync.call(this, key, syncs[key]);
  };
  module.exports = GenericSync;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/inputs/MouseSync", ["npm:famous@0.3.5/core/EventHandler", "npm:famous@0.3.5/core/OptionsManager"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var EventHandler = require("npm:famous@0.3.5/core/EventHandler");
  var OptionsManager = require("npm:famous@0.3.5/core/OptionsManager");
  function MouseSync(options) {
    this.options = Object.create(MouseSync.DEFAULT_OPTIONS);
    this._optionsManager = new OptionsManager(this.options);
    if (options)
      this.setOptions(options);
    this._eventInput = new EventHandler();
    this._eventOutput = new EventHandler();
    EventHandler.setInputHandler(this, this._eventInput);
    EventHandler.setOutputHandler(this, this._eventOutput);
    this._eventInput.on('mousedown', _handleStart.bind(this));
    this._eventInput.on('mousemove', _handleMove.bind(this));
    this._eventInput.on('mouseup', _handleEnd.bind(this));
    if (this.options.propogate)
      this._eventInput.on('mouseleave', _handleLeave.bind(this));
    else
      this._eventInput.on('mouseleave', _handleEnd.bind(this));
    if (this.options.clickThreshold) {
      window.addEventListener('click', function(event) {
        if (Math.sqrt(Math.pow(this._displacement[0], 2) + Math.pow(this._displacement[1], 2)) > this.options.clickThreshold) {
          event.stopPropagation();
        }
      }.bind(this), true);
    }
    this._payload = {
      delta: null,
      position: null,
      velocity: null,
      clientX: 0,
      clientY: 0,
      offsetX: 0,
      offsetY: 0
    };
    this._positionHistory = [];
    this._position = null;
    this._prevCoord = undefined;
    this._prevTime = undefined;
    this._down = false;
    this._moved = false;
    this._displacement = [0, 0];
    this._documentActive = false;
  }
  MouseSync.DEFAULT_OPTIONS = {
    clickThreshold: undefined,
    direction: undefined,
    rails: false,
    scale: 1,
    propogate: true,
    velocitySampleLength: 10,
    preventDefault: true
  };
  MouseSync.DIRECTION_X = 0;
  MouseSync.DIRECTION_Y = 1;
  var MINIMUM_TICK_TIME = 8;
  function _handleStart(event) {
    var delta;
    var velocity;
    if (this.options.preventDefault)
      event.preventDefault();
    var x = event.clientX;
    var y = event.clientY;
    this._prevCoord = [x, y];
    this._prevTime = Date.now();
    this._down = true;
    this._move = false;
    if (this.options.direction !== undefined) {
      this._position = 0;
      delta = 0;
      velocity = 0;
    } else {
      this._position = [0, 0];
      delta = [0, 0];
      velocity = [0, 0];
    }
    if (this.options.clickThreshold) {
      this._displacement = [0, 0];
    }
    var payload = this._payload;
    payload.delta = delta;
    payload.position = this._position;
    payload.velocity = velocity;
    payload.clientX = x;
    payload.clientY = y;
    payload.offsetX = event.offsetX;
    payload.offsetY = event.offsetY;
    this._positionHistory.push({
      position: payload.position.slice ? payload.position.slice(0) : payload.position,
      time: this._prevTime
    });
    this._eventOutput.emit('start', payload);
    this._documentActive = false;
  }
  function _handleMove(event) {
    if (!this._prevCoord)
      return ;
    var prevCoord = this._prevCoord;
    var prevTime = this._prevTime;
    var x = event.clientX;
    var y = event.clientY;
    var currTime = Date.now();
    var diffX = x - prevCoord[0];
    var diffY = y - prevCoord[1];
    if (this.options.rails) {
      if (Math.abs(diffX) > Math.abs(diffY))
        diffY = 0;
      else
        diffX = 0;
    }
    var diffTime = Math.max(currTime - this._positionHistory[0].time, MINIMUM_TICK_TIME);
    var scale = this.options.scale;
    var nextVel;
    var nextDelta;
    if (this.options.direction === MouseSync.DIRECTION_X) {
      nextDelta = scale * diffX;
      this._position += nextDelta;
      nextVel = scale * (this._position - this._positionHistory[0].position) / diffTime;
    } else if (this.options.direction === MouseSync.DIRECTION_Y) {
      nextDelta = scale * diffY;
      this._position += nextDelta;
      nextVel = scale * (this._position - this._positionHistory[0].position) / diffTime;
    } else {
      nextDelta = [scale * diffX, scale * diffY];
      nextVel = [scale * (this._position[0] - this._positionHistory[0].position[0]) / diffTime, scale * (this._position[1] - this._positionHistory[0].position[1]) / diffTime];
      this._position[0] += nextDelta[0];
      this._position[1] += nextDelta[1];
    }
    if (this.options.clickThreshold !== false) {
      this._displacement[0] += diffX;
      this._displacement[1] += diffY;
    }
    var payload = this._payload;
    payload.delta = nextDelta;
    payload.position = this._position;
    payload.velocity = nextVel;
    payload.clientX = x;
    payload.clientY = y;
    payload.offsetX = event.offsetX;
    payload.offsetY = event.offsetY;
    if (this._positionHistory.length === this.options.velocitySampleLength) {
      this._positionHistory.shift();
    }
    this._positionHistory.push({
      position: payload.position.slice ? payload.position.slice(0) : payload.position,
      time: currTime
    });
    this._eventOutput.emit('update', payload);
    this._prevCoord = [x, y];
    this._prevTime = currTime;
    this._move = true;
  }
  function _handleEnd(event) {
    if (!this._down)
      return ;
    this._eventOutput.emit('end', this._payload);
    this._prevCoord = undefined;
    this._prevTime = undefined;
    this._down = false;
    this._move = false;
    this._positionHistory = [];
  }
  function _handleLeave(event) {
    if (!this._down || !this._move)
      return ;
    if (!this._documentActive) {
      var boundMove = _handleMove.bind(this);
      var boundEnd = function(event) {
        _handleEnd.call(this, event);
        document.removeEventListener('mousemove', boundMove);
        document.removeEventListener('mouseup', boundEnd);
      }.bind(this, event);
      document.addEventListener('mousemove', boundMove);
      document.addEventListener('mouseup', boundEnd);
      this._documentActive = true;
    }
  }
  MouseSync.prototype.getOptions = function getOptions() {
    return this.options;
  };
  MouseSync.prototype.setOptions = function setOptions(options) {
    return this._optionsManager.setOptions(options);
  };
  module.exports = MouseSync;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/inputs/TwoFingerSync", ["npm:famous@0.3.5/core/EventHandler"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var EventHandler = require("npm:famous@0.3.5/core/EventHandler");
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
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/inputs/RotateSync", ["npm:famous@0.3.5/inputs/TwoFingerSync", "npm:famous@0.3.5/core/OptionsManager"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var TwoFingerSync = require("npm:famous@0.3.5/inputs/TwoFingerSync");
  var OptionsManager = require("npm:famous@0.3.5/core/OptionsManager");
  function RotateSync(options) {
    TwoFingerSync.call(this);
    this.options = Object.create(RotateSync.DEFAULT_OPTIONS);
    this._optionsManager = new OptionsManager(this.options);
    if (options)
      this.setOptions(options);
    this._angle = 0;
    this._previousAngle = 0;
  }
  RotateSync.prototype = Object.create(TwoFingerSync.prototype);
  RotateSync.prototype.constructor = RotateSync;
  RotateSync.DEFAULT_OPTIONS = {scale: 1};
  RotateSync.prototype._startUpdate = function _startUpdate(event) {
    this._angle = 0;
    this._previousAngle = TwoFingerSync.calculateAngle(this.posA, this.posB);
    var center = TwoFingerSync.calculateCenter(this.posA, this.posB);
    this._eventOutput.emit('start', {
      count: event.touches.length,
      angle: this._angle,
      center: center,
      touches: [this.touchAId, this.touchBId]
    });
  };
  RotateSync.prototype._moveUpdate = function _moveUpdate(diffTime) {
    var scale = this.options.scale;
    var currAngle = TwoFingerSync.calculateAngle(this.posA, this.posB);
    var center = TwoFingerSync.calculateCenter(this.posA, this.posB);
    var diffTheta = scale * (currAngle - this._previousAngle);
    var velTheta = diffTheta / diffTime;
    this._angle += diffTheta;
    this._eventOutput.emit('update', {
      delta: diffTheta,
      velocity: velTheta,
      angle: this._angle,
      center: center,
      touches: [this.touchAId, this.touchBId]
    });
    this._previousAngle = currAngle;
  };
  RotateSync.prototype.getOptions = function getOptions() {
    return this.options;
  };
  RotateSync.prototype.setOptions = function setOptions(options) {
    return this._optionsManager.setOptions(options);
  };
  module.exports = RotateSync;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/inputs/ScaleSync", ["npm:famous@0.3.5/inputs/TwoFingerSync", "npm:famous@0.3.5/core/OptionsManager"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var TwoFingerSync = require("npm:famous@0.3.5/inputs/TwoFingerSync");
  var OptionsManager = require("npm:famous@0.3.5/core/OptionsManager");
  function ScaleSync(options) {
    TwoFingerSync.call(this);
    this.options = Object.create(ScaleSync.DEFAULT_OPTIONS);
    this._optionsManager = new OptionsManager(this.options);
    if (options)
      this.setOptions(options);
    this._scaleFactor = 1;
    this._startDist = 0;
    this._eventInput.on('pipe', _reset.bind(this));
  }
  ScaleSync.prototype = Object.create(TwoFingerSync.prototype);
  ScaleSync.prototype.constructor = ScaleSync;
  ScaleSync.DEFAULT_OPTIONS = {scale: 1};
  function _reset() {
    this.touchAId = undefined;
    this.touchBId = undefined;
  }
  ScaleSync.prototype._startUpdate = function _startUpdate(event) {
    this._scaleFactor = 1;
    this._startDist = TwoFingerSync.calculateDistance(this.posA, this.posB);
    this._eventOutput.emit('start', {
      count: event.touches.length,
      touches: [this.touchAId, this.touchBId],
      distance: this._startDist,
      center: TwoFingerSync.calculateCenter(this.posA, this.posB)
    });
  };
  ScaleSync.prototype._moveUpdate = function _moveUpdate(diffTime) {
    var scale = this.options.scale;
    var currDist = TwoFingerSync.calculateDistance(this.posA, this.posB);
    var center = TwoFingerSync.calculateCenter(this.posA, this.posB);
    var delta = (currDist - this._startDist) / this._startDist;
    var newScaleFactor = Math.max(1 + scale * delta, 0);
    var veloScale = (newScaleFactor - this._scaleFactor) / diffTime;
    this._eventOutput.emit('update', {
      delta: delta,
      scale: newScaleFactor,
      velocity: veloScale,
      distance: currDist,
      center: center,
      touches: [this.touchAId, this.touchBId]
    });
    this._scaleFactor = newScaleFactor;
  };
  ScaleSync.prototype.getOptions = function getOptions() {
    return this.options;
  };
  ScaleSync.prototype.setOptions = function setOptions(options) {
    return this._optionsManager.setOptions(options);
  };
  module.exports = ScaleSync;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/inputs/ScrollSync", ["npm:famous@0.3.5/core/EventHandler", "npm:famous@0.3.5/core/Engine", "npm:famous@0.3.5/core/OptionsManager"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var EventHandler = require("npm:famous@0.3.5/core/EventHandler");
  var Engine = require("npm:famous@0.3.5/core/Engine");
  var OptionsManager = require("npm:famous@0.3.5/core/OptionsManager");
  function ScrollSync(options) {
    this.options = Object.create(ScrollSync.DEFAULT_OPTIONS);
    this._optionsManager = new OptionsManager(this.options);
    if (options)
      this.setOptions(options);
    this._payload = {
      delta: null,
      position: null,
      velocity: null,
      slip: true
    };
    this._eventInput = new EventHandler();
    this._eventOutput = new EventHandler();
    EventHandler.setInputHandler(this, this._eventInput);
    EventHandler.setOutputHandler(this, this._eventOutput);
    this._position = this.options.direction === undefined ? [0, 0] : 0;
    this._prevTime = undefined;
    this._prevVel = undefined;
    this._eventInput.on('mousewheel', _handleMove.bind(this));
    this._eventInput.on('wheel', _handleMove.bind(this));
    this._inProgress = false;
    this._loopBound = false;
  }
  ScrollSync.DEFAULT_OPTIONS = {
    direction: undefined,
    minimumEndSpeed: Infinity,
    rails: false,
    scale: 1,
    stallTime: 50,
    lineHeight: 40,
    preventDefault: true
  };
  ScrollSync.DIRECTION_X = 0;
  ScrollSync.DIRECTION_Y = 1;
  var MINIMUM_TICK_TIME = 8;
  var _now = Date.now;
  function _newFrame() {
    if (this._inProgress && _now() - this._prevTime > this.options.stallTime) {
      this._inProgress = false;
      var finalVel = Math.abs(this._prevVel) >= this.options.minimumEndSpeed ? this._prevVel : 0;
      var payload = this._payload;
      payload.position = this._position;
      payload.velocity = finalVel;
      payload.slip = true;
      this._eventOutput.emit('end', payload);
    }
  }
  function _handleMove(event) {
    if (this.options.preventDefault)
      event.preventDefault();
    if (!this._inProgress) {
      this._inProgress = true;
      this._position = this.options.direction === undefined ? [0, 0] : 0;
      payload = this._payload;
      payload.slip = true;
      payload.position = this._position;
      payload.clientX = event.clientX;
      payload.clientY = event.clientY;
      payload.offsetX = event.offsetX;
      payload.offsetY = event.offsetY;
      this._eventOutput.emit('start', payload);
      if (!this._loopBound) {
        Engine.on('prerender', _newFrame.bind(this));
        this._loopBound = true;
      }
    }
    var currTime = _now();
    var prevTime = this._prevTime || currTime;
    var diffX = event.wheelDeltaX !== undefined ? event.wheelDeltaX : -event.deltaX;
    var diffY = event.wheelDeltaY !== undefined ? event.wheelDeltaY : -event.deltaY;
    if (event.deltaMode === 1) {
      diffX *= this.options.lineHeight;
      diffY *= this.options.lineHeight;
    }
    if (this.options.rails) {
      if (Math.abs(diffX) > Math.abs(diffY))
        diffY = 0;
      else
        diffX = 0;
    }
    var diffTime = Math.max(currTime - prevTime, MINIMUM_TICK_TIME);
    var velX = diffX / diffTime;
    var velY = diffY / diffTime;
    var scale = this.options.scale;
    var nextVel;
    var nextDelta;
    if (this.options.direction === ScrollSync.DIRECTION_X) {
      nextDelta = scale * diffX;
      nextVel = scale * velX;
      this._position += nextDelta;
    } else if (this.options.direction === ScrollSync.DIRECTION_Y) {
      nextDelta = scale * diffY;
      nextVel = scale * velY;
      this._position += nextDelta;
    } else {
      nextDelta = [scale * diffX, scale * diffY];
      nextVel = [scale * velX, scale * velY];
      this._position[0] += nextDelta[0];
      this._position[1] += nextDelta[1];
    }
    var payload = this._payload;
    payload.delta = nextDelta;
    payload.velocity = nextVel;
    payload.position = this._position;
    payload.slip = true;
    this._eventOutput.emit('update', payload);
    this._prevTime = currTime;
    this._prevVel = nextVel;
  }
  ScrollSync.prototype.getOptions = function getOptions() {
    return this.options;
  };
  ScrollSync.prototype.setOptions = function setOptions(options) {
    return this._optionsManager.setOptions(options);
  };
  module.exports = ScrollSync;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/inputs/TouchTracker", ["npm:famous@0.3.5/core/EventHandler"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var EventHandler = require("npm:famous@0.3.5/core/EventHandler");
  var _now = Date.now;
  function _timestampTouch(touch, event, history) {
    return {
      x: touch.clientX,
      y: touch.clientY,
      identifier: touch.identifier,
      origin: event.origin,
      timestamp: _now(),
      count: event.touches.length,
      history: history
    };
  }
  function _handleStart(event) {
    if (event.touches.length > this.touchLimit)
      return ;
    this.isTouched = true;
    for (var i = 0; i < event.changedTouches.length; i++) {
      var touch = event.changedTouches[i];
      var data = _timestampTouch(touch, event, null);
      this.eventOutput.emit('trackstart', data);
      if (!this.selective && !this.touchHistory[touch.identifier])
        this.track(data);
    }
  }
  function _handleMove(event) {
    if (event.touches.length > this.touchLimit)
      return ;
    for (var i = 0; i < event.changedTouches.length; i++) {
      var touch = event.changedTouches[i];
      var history = this.touchHistory[touch.identifier];
      if (history) {
        var data = _timestampTouch(touch, event, history);
        this.touchHistory[touch.identifier].push(data);
        this.eventOutput.emit('trackmove', data);
      }
    }
  }
  function _handleEnd(event) {
    if (!this.isTouched)
      return ;
    for (var i = 0; i < event.changedTouches.length; i++) {
      var touch = event.changedTouches[i];
      var history = this.touchHistory[touch.identifier];
      if (history) {
        var data = _timestampTouch(touch, event, history);
        this.eventOutput.emit('trackend', data);
        delete this.touchHistory[touch.identifier];
      }
    }
    this.isTouched = false;
  }
  function _handleUnpipe() {
    for (var i in this.touchHistory) {
      var history = this.touchHistory[i];
      this.eventOutput.emit('trackend', {
        touch: history[history.length - 1].touch,
        timestamp: Date.now(),
        count: 0,
        history: history
      });
      delete this.touchHistory[i];
    }
  }
  function TouchTracker(options) {
    this.selective = options.selective;
    this.touchLimit = options.touchLimit || 1;
    this.touchHistory = {};
    this.eventInput = new EventHandler();
    this.eventOutput = new EventHandler();
    EventHandler.setInputHandler(this, this.eventInput);
    EventHandler.setOutputHandler(this, this.eventOutput);
    this.eventInput.on('touchstart', _handleStart.bind(this));
    this.eventInput.on('touchmove', _handleMove.bind(this));
    this.eventInput.on('touchend', _handleEnd.bind(this));
    this.eventInput.on('touchcancel', _handleEnd.bind(this));
    this.eventInput.on('unpipe', _handleUnpipe.bind(this));
    this.isTouched = false;
  }
  TouchTracker.prototype.track = function track(data) {
    this.touchHistory[data.identifier] = [data];
  };
  module.exports = TouchTracker;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/math/Vector", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  function Vector(x, y, z) {
    if (arguments.length === 1 && x !== undefined)
      this.set(x);
    else {
      this.x = x || 0;
      this.y = y || 0;
      this.z = z || 0;
    }
    return this;
  }
  var _register = new Vector(0, 0, 0);
  Vector.prototype.add = function add(v) {
    return _setXYZ.call(_register, this.x + v.x, this.y + v.y, this.z + v.z);
  };
  Vector.prototype.sub = function sub(v) {
    return _setXYZ.call(_register, this.x - v.x, this.y - v.y, this.z - v.z);
  };
  Vector.prototype.mult = function mult(r) {
    return _setXYZ.call(_register, r * this.x, r * this.y, r * this.z);
  };
  Vector.prototype.div = function div(r) {
    return this.mult(1 / r);
  };
  Vector.prototype.cross = function cross(v) {
    var x = this.x;
    var y = this.y;
    var z = this.z;
    var vx = v.x;
    var vy = v.y;
    var vz = v.z;
    return _setXYZ.call(_register, z * vy - y * vz, x * vz - z * vx, y * vx - x * vy);
  };
  Vector.prototype.equals = function equals(v) {
    return v.x === this.x && v.y === this.y && v.z === this.z;
  };
  Vector.prototype.rotateX = function rotateX(theta) {
    var x = this.x;
    var y = this.y;
    var z = this.z;
    var cosTheta = Math.cos(theta);
    var sinTheta = Math.sin(theta);
    return _setXYZ.call(_register, x, y * cosTheta - z * sinTheta, y * sinTheta + z * cosTheta);
  };
  Vector.prototype.rotateY = function rotateY(theta) {
    var x = this.x;
    var y = this.y;
    var z = this.z;
    var cosTheta = Math.cos(theta);
    var sinTheta = Math.sin(theta);
    return _setXYZ.call(_register, z * sinTheta + x * cosTheta, y, z * cosTheta - x * sinTheta);
  };
  Vector.prototype.rotateZ = function rotateZ(theta) {
    var x = this.x;
    var y = this.y;
    var z = this.z;
    var cosTheta = Math.cos(theta);
    var sinTheta = Math.sin(theta);
    return _setXYZ.call(_register, x * cosTheta - y * sinTheta, x * sinTheta + y * cosTheta, z);
  };
  Vector.prototype.dot = function dot(v) {
    return this.x * v.x + this.y * v.y + this.z * v.z;
  };
  Vector.prototype.normSquared = function normSquared() {
    return this.dot(this);
  };
  Vector.prototype.norm = function norm() {
    return Math.sqrt(this.normSquared());
  };
  Vector.prototype.normalize = function normalize(length) {
    if (arguments.length === 0)
      length = 1;
    var norm = this.norm();
    if (norm > 1e-7)
      return _setFromVector.call(_register, this.mult(length / norm));
    else
      return _setXYZ.call(_register, length, 0, 0);
  };
  Vector.prototype.clone = function clone() {
    return new Vector(this);
  };
  Vector.prototype.isZero = function isZero() {
    return !(this.x || this.y || this.z);
  };
  function _setXYZ(x, y, z) {
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }
  function _setFromArray(v) {
    return _setXYZ.call(this, v[0], v[1], v[2] || 0);
  }
  function _setFromVector(v) {
    return _setXYZ.call(this, v.x, v.y, v.z);
  }
  function _setFromNumber(x) {
    return _setXYZ.call(this, x, 0, 0);
  }
  Vector.prototype.set = function set(v) {
    if (v instanceof Array)
      return _setFromArray.call(this, v);
    if (typeof v === 'number')
      return _setFromNumber.call(this, v);
    return _setFromVector.call(this, v);
  };
  Vector.prototype.setXYZ = function(x, y, z) {
    return _setXYZ.apply(this, arguments);
  };
  Vector.prototype.set1D = function(x) {
    return _setFromNumber.call(this, x);
  };
  Vector.prototype.put = function put(v) {
    if (this === _register)
      _setFromVector.call(v, _register);
    else
      _setFromVector.call(v, this);
  };
  Vector.prototype.clear = function clear() {
    return _setXYZ.call(this, 0, 0, 0);
  };
  Vector.prototype.cap = function cap(cap) {
    if (cap === Infinity)
      return _setFromVector.call(_register, this);
    var norm = this.norm();
    if (norm > cap)
      return _setFromVector.call(_register, this.mult(cap / norm));
    else
      return _setFromVector.call(_register, this);
  };
  Vector.prototype.project = function project(n) {
    return n.mult(this.dot(n));
  };
  Vector.prototype.reflectAcross = function reflectAcross(n) {
    n.normalize().put(n);
    return _setFromVector(_register, this.sub(this.project(n).mult(2)));
  };
  Vector.prototype.get = function get() {
    return [this.x, this.y, this.z];
  };
  Vector.prototype.get1D = function() {
    return this.x;
  };
  module.exports = Vector;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/math/Quaternion", ["npm:famous@0.3.5/math/Matrix"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var Matrix = require("npm:famous@0.3.5/math/Matrix");
  function Quaternion(w, x, y, z) {
    if (arguments.length === 1)
      this.set(w);
    else {
      this.w = w !== undefined ? w : 1;
      this.x = x !== undefined ? x : 0;
      this.y = y !== undefined ? y : 0;
      this.z = z !== undefined ? z : 0;
    }
    return this;
  }
  var register = new Quaternion(1, 0, 0, 0);
  Quaternion.prototype.add = function add(q) {
    return register.setWXYZ(this.w + q.w, this.x + q.x, this.y + q.y, this.z + q.z);
  };
  Quaternion.prototype.sub = function sub(q) {
    return register.setWXYZ(this.w - q.w, this.x - q.x, this.y - q.y, this.z - q.z);
  };
  Quaternion.prototype.scalarDivide = function scalarDivide(s) {
    return this.scalarMultiply(1 / s);
  };
  Quaternion.prototype.scalarMultiply = function scalarMultiply(s) {
    return register.setWXYZ(this.w * s, this.x * s, this.y * s, this.z * s);
  };
  Quaternion.prototype.multiply = function multiply(q) {
    var x1 = this.x;
    var y1 = this.y;
    var z1 = this.z;
    var w1 = this.w;
    var x2 = q.x;
    var y2 = q.y;
    var z2 = q.z;
    var w2 = q.w || 0;
    return register.setWXYZ(w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2, x1 * w2 + x2 * w1 + y2 * z1 - y1 * z2, y1 * w2 + y2 * w1 + x1 * z2 - x2 * z1, z1 * w2 + z2 * w1 + x2 * y1 - x1 * y2);
  };
  var conj = new Quaternion(1, 0, 0, 0);
  Quaternion.prototype.rotateVector = function rotateVector(v) {
    conj.set(this.conj());
    return register.set(this.multiply(v).multiply(conj));
  };
  Quaternion.prototype.inverse = function inverse() {
    return register.set(this.conj().scalarDivide(this.normSquared()));
  };
  Quaternion.prototype.negate = function negate() {
    return this.scalarMultiply(-1);
  };
  Quaternion.prototype.conj = function conj() {
    return register.setWXYZ(this.w, -this.x, -this.y, -this.z);
  };
  Quaternion.prototype.normalize = function normalize(length) {
    length = length === undefined ? 1 : length;
    return this.scalarDivide(length * this.norm());
  };
  Quaternion.prototype.makeFromAngleAndAxis = function makeFromAngleAndAxis(angle, v) {
    var n = v.normalize();
    var ha = angle * 0.5;
    var s = -Math.sin(ha);
    this.x = s * n.x;
    this.y = s * n.y;
    this.z = s * n.z;
    this.w = Math.cos(ha);
    return this;
  };
  Quaternion.prototype.setWXYZ = function setWXYZ(w, x, y, z) {
    register.clear();
    this.w = w;
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  };
  Quaternion.prototype.set = function set(v) {
    if (v instanceof Array) {
      this.w = 0;
      this.x = v[0];
      this.y = v[1];
      this.z = v[2];
    } else {
      this.w = v.w;
      this.x = v.x;
      this.y = v.y;
      this.z = v.z;
    }
    if (this !== register)
      register.clear();
    return this;
  };
  Quaternion.prototype.put = function put(q) {
    q.set(register);
  };
  Quaternion.prototype.clone = function clone() {
    return new Quaternion(this);
  };
  Quaternion.prototype.clear = function clear() {
    this.w = 1;
    this.x = 0;
    this.y = 0;
    this.z = 0;
    return this;
  };
  Quaternion.prototype.isEqual = function isEqual(q) {
    return q.w === this.w && q.x === this.x && q.y === this.y && q.z === this.z;
  };
  Quaternion.prototype.dot = function dot(q) {
    return this.w * q.w + this.x * q.x + this.y * q.y + this.z * q.z;
  };
  Quaternion.prototype.normSquared = function normSquared() {
    return this.dot(this);
  };
  Quaternion.prototype.norm = function norm() {
    return Math.sqrt(this.normSquared());
  };
  Quaternion.prototype.isZero = function isZero() {
    return !(this.x || this.y || this.z);
  };
  Quaternion.prototype.getTransform = function getTransform() {
    var temp = this.normalize(1);
    var x = temp.x;
    var y = temp.y;
    var z = temp.z;
    var w = temp.w;
    return [1 - 2 * y * y - 2 * z * z, 2 * x * y - 2 * z * w, 2 * x * z + 2 * y * w, 0, 2 * x * y + 2 * z * w, 1 - 2 * x * x - 2 * z * z, 2 * y * z - 2 * x * w, 0, 2 * x * z - 2 * y * w, 2 * y * z + 2 * x * w, 1 - 2 * x * x - 2 * y * y, 0, 0, 0, 0, 1];
  };
  var matrixRegister = new Matrix();
  Quaternion.prototype.getMatrix = function getMatrix() {
    var temp = this.normalize(1);
    var x = temp.x;
    var y = temp.y;
    var z = temp.z;
    var w = temp.w;
    return matrixRegister.set([[1 - 2 * y * y - 2 * z * z, 2 * x * y + 2 * z * w, 2 * x * z - 2 * y * w], [2 * x * y - 2 * z * w, 1 - 2 * x * x - 2 * z * z, 2 * y * z + 2 * x * w], [2 * x * z + 2 * y * w, 2 * y * z - 2 * x * w, 1 - 2 * x * x - 2 * y * y]]);
  };
  var epsilon = 0.00001;
  Quaternion.prototype.slerp = function slerp(q, t) {
    var omega;
    var cosomega;
    var sinomega;
    var scaleFrom;
    var scaleTo;
    cosomega = this.dot(q);
    if (1 - cosomega > epsilon) {
      omega = Math.acos(cosomega);
      sinomega = Math.sin(omega);
      scaleFrom = Math.sin((1 - t) * omega) / sinomega;
      scaleTo = Math.sin(t * omega) / sinomega;
    } else {
      scaleFrom = 1 - t;
      scaleTo = t;
    }
    return register.set(this.scalarMultiply(scaleFrom / scaleTo).add(q).scalarMultiply(scaleTo));
  };
  module.exports = Quaternion;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/math/Random", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var RAND = Math.random;
  function _randomFloat(min, max) {
    return min + RAND() * (max - min);
  }
  function _randomInteger(min, max) {
    return min + (RAND() * (max - min + 1) >> 0);
  }
  function _range(randomFunction, min, max, dim) {
    min = min !== undefined ? min : 0;
    max = max !== undefined ? max : 1;
    if (dim !== undefined) {
      var result = [];
      for (var i = 0; i < dim; i++)
        result.push(randomFunction(min, max));
      return result;
    } else
      return randomFunction(min, max);
  }
  var Random = {};
  Random.integer = function integer(min, max, dim) {
    return _range(_randomInteger, min, max, dim);
  };
  Random.range = function range(min, max, dim) {
    return _range(_randomFloat, min, max, dim);
  };
  Random.sign = function sign(prob) {
    return Random.bool(prob) ? 1 : -1;
  };
  Random.bool = function bool(prob) {
    prob = prob !== undefined ? prob : 0.5;
    return RAND() < prob;
  };
  module.exports = Random;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/math/Utilities", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var Utilities = {};
  Utilities.clamp = function clamp(value, range) {
    return Math.max(Math.min(value, range[1]), range[0]);
  };
  Utilities.length = function length(array) {
    var distanceSquared = 0;
    for (var i = 0; i < array.length; i++) {
      distanceSquared += array[i] * array[i];
    }
    return Math.sqrt(distanceSquared);
  };
  module.exports = Utilities;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/modifiers/Draggable", ["npm:famous@0.3.5/core/Transform", "npm:famous@0.3.5/transitions/Transitionable", "npm:famous@0.3.5/core/EventHandler", "npm:famous@0.3.5/math/Utilities", "npm:famous@0.3.5/inputs/GenericSync", "npm:famous@0.3.5/inputs/MouseSync", "npm:famous@0.3.5/inputs/TouchSync"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var Transform = require("npm:famous@0.3.5/core/Transform");
  var Transitionable = require("npm:famous@0.3.5/transitions/Transitionable");
  var EventHandler = require("npm:famous@0.3.5/core/EventHandler");
  var Utilities = require("npm:famous@0.3.5/math/Utilities");
  var GenericSync = require("npm:famous@0.3.5/inputs/GenericSync");
  var MouseSync = require("npm:famous@0.3.5/inputs/MouseSync");
  var TouchSync = require("npm:famous@0.3.5/inputs/TouchSync");
  GenericSync.register({
    'mouse': MouseSync,
    'touch': TouchSync
  });
  function Draggable(options) {
    this.options = Object.create(Draggable.DEFAULT_OPTIONS);
    if (options)
      this.setOptions(options);
    this._positionState = new Transitionable([0, 0]);
    this._differential = [0, 0];
    this._active = true;
    this.sync = new GenericSync(['mouse', 'touch'], {scale: this.options.scale});
    this.eventOutput = new EventHandler();
    EventHandler.setInputHandler(this, this.sync);
    EventHandler.setOutputHandler(this, this.eventOutput);
    _bindEvents.call(this);
  }
  var _direction = {
    x: 1,
    y: 2
  };
  Draggable.DIRECTION_X = _direction.x;
  Draggable.DIRECTION_Y = _direction.y;
  var _clamp = Utilities.clamp;
  Draggable.DEFAULT_OPTIONS = {
    projection: _direction.x | _direction.y,
    scale: 1,
    xRange: null,
    yRange: null,
    snapX: 0,
    snapY: 0,
    transition: {duration: 0}
  };
  function _mapDifferential(differential) {
    var opts = this.options;
    var projection = opts.projection;
    var snapX = opts.snapX;
    var snapY = opts.snapY;
    var tx = projection & _direction.x ? differential[0] : 0;
    var ty = projection & _direction.y ? differential[1] : 0;
    if (snapX > 0)
      tx -= tx % snapX;
    if (snapY > 0)
      ty -= ty % snapY;
    return [tx, ty];
  }
  function _handleStart() {
    if (!this._active)
      return ;
    if (this._positionState.isActive())
      this._positionState.halt();
    this.eventOutput.emit('start', {position: this.getPosition()});
  }
  function _handleMove(event) {
    if (!this._active)
      return ;
    var options = this.options;
    this._differential = event.position;
    var newDifferential = _mapDifferential.call(this, this._differential);
    this._differential[0] -= newDifferential[0];
    this._differential[1] -= newDifferential[1];
    var pos = this.getPosition();
    pos[0] += newDifferential[0];
    pos[1] += newDifferential[1];
    if (options.xRange) {
      var xRange = [options.xRange[0] + 0.5 * options.snapX, options.xRange[1] - 0.5 * options.snapX];
      pos[0] = _clamp(pos[0], xRange);
    }
    if (options.yRange) {
      var yRange = [options.yRange[0] + 0.5 * options.snapY, options.yRange[1] - 0.5 * options.snapY];
      pos[1] = _clamp(pos[1], yRange);
    }
    this.eventOutput.emit('update', {position: pos});
  }
  function _handleEnd() {
    if (!this._active)
      return ;
    this.eventOutput.emit('end', {position: this.getPosition()});
  }
  function _bindEvents() {
    this.sync.on('start', _handleStart.bind(this));
    this.sync.on('update', _handleMove.bind(this));
    this.sync.on('end', _handleEnd.bind(this));
  }
  Draggable.prototype.setOptions = function setOptions(options) {
    var currentOptions = this.options;
    if (options.projection !== undefined) {
      var proj = options.projection;
      this.options.projection = 0;
      ['x', 'y'].forEach(function(val) {
        if (proj.indexOf(val) !== -1)
          currentOptions.projection |= _direction[val];
      });
    }
    if (options.scale !== undefined) {
      currentOptions.scale = options.scale;
      this.sync.setOptions({scale: options.scale});
    }
    if (options.xRange !== undefined)
      currentOptions.xRange = options.xRange;
    if (options.yRange !== undefined)
      currentOptions.yRange = options.yRange;
    if (options.snapX !== undefined)
      currentOptions.snapX = options.snapX;
    if (options.snapY !== undefined)
      currentOptions.snapY = options.snapY;
  };
  Draggable.prototype.getPosition = function getPosition() {
    return this._positionState.get();
  };
  Draggable.prototype.setRelativePosition = function setRelativePosition(position, transition, callback) {
    var currPos = this.getPosition();
    var relativePosition = [currPos[0] + position[0], currPos[1] + position[1]];
    this.setPosition(relativePosition, transition, callback);
  };
  Draggable.prototype.setPosition = function setPosition(position, transition, callback) {
    if (this._positionState.isActive())
      this._positionState.halt();
    this._positionState.set(position, transition, callback);
  };
  Draggable.prototype.activate = function activate() {
    this._active = true;
  };
  Draggable.prototype.deactivate = function deactivate() {
    this._active = false;
  };
  Draggable.prototype.toggle = function toggle() {
    this._active = !this._active;
  };
  Draggable.prototype.modify = function modify(target) {
    var pos = this.getPosition();
    return {
      transform: Transform.translate(pos[0], pos[1]),
      target: target
    };
  };
  module.exports = Draggable;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/modifiers/Fader", ["npm:famous@0.3.5/transitions/Transitionable", "npm:famous@0.3.5/core/OptionsManager"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var Transitionable = require("npm:famous@0.3.5/transitions/Transitionable");
  var OptionsManager = require("npm:famous@0.3.5/core/OptionsManager");
  function Fader(options, startState) {
    this.options = Object.create(Fader.DEFAULT_OPTIONS);
    this._optionsManager = new OptionsManager(this.options);
    if (options)
      this.setOptions(options);
    if (!startState)
      startState = 0;
    this.transitionHelper = new Transitionable(startState);
  }
  Fader.DEFAULT_OPTIONS = {
    cull: false,
    transition: true,
    pulseInTransition: true,
    pulseOutTransition: true
  };
  Fader.prototype.setOptions = function setOptions(options) {
    return this._optionsManager.setOptions(options);
  };
  Fader.prototype.show = function show(transition, callback) {
    transition = transition || this.options.transition;
    this.set(1, transition, callback);
  };
  Fader.prototype.hide = function hide(transition, callback) {
    transition = transition || this.options.transition;
    this.set(0, transition, callback);
  };
  Fader.prototype.set = function set(state, transition, callback) {
    this.halt();
    this.transitionHelper.set(state, transition, callback);
  };
  Fader.prototype.halt = function halt() {
    this.transitionHelper.halt();
  };
  Fader.prototype.isVisible = function isVisible() {
    return this.transitionHelper.get() > 0;
  };
  Fader.prototype.modify = function modify(target) {
    var currOpacity = this.transitionHelper.get();
    if (this.options.cull && !currOpacity)
      return undefined;
    else
      return {
        opacity: currOpacity,
        target: target
      };
  };
  module.exports = Fader;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/modifiers/ModifierChain", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  function ModifierChain() {
    this._chain = [];
    if (arguments.length)
      this.addModifier.apply(this, arguments);
  }
  ModifierChain.prototype.addModifier = function addModifier(varargs) {
    Array.prototype.push.apply(this._chain, arguments);
  };
  ModifierChain.prototype.removeModifier = function removeModifier(modifier) {
    var index = this._chain.indexOf(modifier);
    if (index < 0)
      return ;
    this._chain.splice(index, 1);
  };
  ModifierChain.prototype.modify = function modify(input) {
    var chain = this._chain;
    var result = input;
    for (var i = 0; i < chain.length; i++) {
      result = chain[i].modify(result);
    }
    return result;
  };
  module.exports = ModifierChain;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/modifiers/StateModifier", ["npm:famous@0.3.5/core/Modifier", "npm:famous@0.3.5/core/Transform", "npm:famous@0.3.5/transitions/Transitionable", "npm:famous@0.3.5/transitions/TransitionableTransform"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var Modifier = require("npm:famous@0.3.5/core/Modifier");
  var Transform = require("npm:famous@0.3.5/core/Transform");
  var Transitionable = require("npm:famous@0.3.5/transitions/Transitionable");
  var TransitionableTransform = require("npm:famous@0.3.5/transitions/TransitionableTransform");
  function StateModifier(options) {
    this._transformState = new TransitionableTransform(Transform.identity);
    this._opacityState = new Transitionable(1);
    this._originState = new Transitionable([0, 0]);
    this._alignState = new Transitionable([0, 0]);
    this._sizeState = new Transitionable([0, 0]);
    this._proportionsState = new Transitionable([0, 0]);
    this._modifier = new Modifier({
      transform: this._transformState,
      opacity: this._opacityState,
      origin: null,
      align: null,
      size: null,
      proportions: null
    });
    this._hasOrigin = false;
    this._hasAlign = false;
    this._hasSize = false;
    this._hasProportions = false;
    if (options) {
      if (options.transform)
        this.setTransform(options.transform);
      if (options.opacity !== undefined)
        this.setOpacity(options.opacity);
      if (options.origin)
        this.setOrigin(options.origin);
      if (options.align)
        this.setAlign(options.align);
      if (options.size)
        this.setSize(options.size);
      if (options.proportions)
        this.setProportions(options.proportions);
    }
  }
  StateModifier.prototype.setTransform = function setTransform(transform, transition, callback) {
    this._transformState.set(transform, transition, callback);
    return this;
  };
  StateModifier.prototype.setOpacity = function setOpacity(opacity, transition, callback) {
    this._opacityState.set(opacity, transition, callback);
    return this;
  };
  StateModifier.prototype.setOrigin = function setOrigin(origin, transition, callback) {
    if (origin === null) {
      if (this._hasOrigin) {
        this._modifier.originFrom(null);
        this._hasOrigin = false;
      }
      return this;
    } else if (!this._hasOrigin) {
      this._hasOrigin = true;
      this._modifier.originFrom(this._originState);
    }
    this._originState.set(origin, transition, callback);
    return this;
  };
  StateModifier.prototype.setAlign = function setOrigin(align, transition, callback) {
    if (align === null) {
      if (this._hasAlign) {
        this._modifier.alignFrom(null);
        this._hasAlign = false;
      }
      return this;
    } else if (!this._hasAlign) {
      this._hasAlign = true;
      this._modifier.alignFrom(this._alignState);
    }
    this._alignState.set(align, transition, callback);
    return this;
  };
  StateModifier.prototype.setSize = function setSize(size, transition, callback) {
    if (size === null) {
      if (this._hasSize) {
        this._modifier.sizeFrom(null);
        this._hasSize = false;
      }
      return this;
    } else if (!this._hasSize) {
      this._hasSize = true;
      this._modifier.sizeFrom(this._sizeState);
    }
    this._sizeState.set(size, transition, callback);
    return this;
  };
  StateModifier.prototype.setProportions = function setSize(proportions, transition, callback) {
    if (proportions === null) {
      if (this._hasProportions) {
        this._modifier.proportionsFrom(null);
        this._hasProportions = false;
      }
      return this;
    } else if (!this._hasProportions) {
      this._hasProportions = true;
      this._modifier.proportionsFrom(this._proportionsState);
    }
    this._proportionsState.set(proportions, transition, callback);
    return this;
  };
  StateModifier.prototype.halt = function halt() {
    this._transformState.halt();
    this._opacityState.halt();
    this._originState.halt();
    this._alignState.halt();
    this._sizeState.halt();
    this._proportionsState.halt();
  };
  StateModifier.prototype.getTransform = function getTransform() {
    return this._transformState.get();
  };
  StateModifier.prototype.getFinalTransform = function getFinalTransform() {
    return this._transformState.getFinal();
  };
  StateModifier.prototype.getOpacity = function getOpacity() {
    return this._opacityState.get();
  };
  StateModifier.prototype.getOrigin = function getOrigin() {
    return this._hasOrigin ? this._originState.get() : null;
  };
  StateModifier.prototype.getAlign = function getAlign() {
    return this._hasAlign ? this._alignState.get() : null;
  };
  StateModifier.prototype.getSize = function getSize() {
    return this._hasSize ? this._sizeState.get() : null;
  };
  StateModifier.prototype.getProportions = function getProportions() {
    return this._hasProportions ? this._proportionsState.get() : null;
  };
  StateModifier.prototype.modify = function modify(target) {
    return this._modifier.modify(target);
  };
  module.exports = StateModifier;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/physics/PhysicsEngine", ["npm:famous@0.3.5/core/EventHandler"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var EventHandler = require("npm:famous@0.3.5/core/EventHandler");
  function PhysicsEngine(options) {
    this.options = Object.create(PhysicsEngine.DEFAULT_OPTIONS);
    if (options)
      this.setOptions(options);
    this._particles = [];
    this._bodies = [];
    this._agentData = {};
    this._forces = [];
    this._constraints = [];
    this._buffer = 0;
    this._prevTime = now();
    this._isSleeping = false;
    this._eventHandler = null;
    this._currAgentId = 0;
    this._hasBodies = false;
    this._eventHandler = null;
  }
  var TIMESTEP = 17;
  var MIN_TIME_STEP = 1000 / 120;
  var MAX_TIME_STEP = 17;
  var now = Date.now;
  var _events = {
    start: 'start',
    update: 'update',
    end: 'end'
  };
  PhysicsEngine.DEFAULT_OPTIONS = {
    constraintSteps: 1,
    sleepTolerance: 1e-7,
    velocityCap: undefined,
    angularVelocityCap: undefined
  };
  PhysicsEngine.prototype.setOptions = function setOptions(opts) {
    for (var key in opts)
      if (this.options[key])
        this.options[key] = opts[key];
  };
  PhysicsEngine.prototype.addBody = function addBody(body) {
    body._engine = this;
    if (body.isBody) {
      this._bodies.push(body);
      this._hasBodies = true;
    } else
      this._particles.push(body);
    body.on('start', this.wake.bind(this));
    return body;
  };
  PhysicsEngine.prototype.removeBody = function removeBody(body) {
    var array = body.isBody ? this._bodies : this._particles;
    var index = array.indexOf(body);
    if (index > -1) {
      for (var agentKey in this._agentData) {
        if (this._agentData.hasOwnProperty(agentKey)) {
          this.detachFrom(this._agentData[agentKey].id, body);
        }
      }
      array.splice(index, 1);
    }
    if (this.getBodies().length === 0)
      this._hasBodies = false;
  };
  function _mapAgentArray(agent) {
    if (agent.applyForce)
      return this._forces;
    if (agent.applyConstraint)
      return this._constraints;
  }
  function _attachOne(agent, targets, source) {
    if (targets === undefined)
      targets = this.getParticlesAndBodies();
    if (!(targets instanceof Array))
      targets = [targets];
    agent.on('change', this.wake.bind(this));
    this._agentData[this._currAgentId] = {
      agent: agent,
      id: this._currAgentId,
      targets: targets,
      source: source
    };
    _mapAgentArray.call(this, agent).push(this._currAgentId);
    return this._currAgentId++;
  }
  PhysicsEngine.prototype.attach = function attach(agents, targets, source) {
    this.wake();
    if (agents instanceof Array) {
      var agentIDs = [];
      for (var i = 0; i < agents.length; i++)
        agentIDs[i] = _attachOne.call(this, agents[i], targets, source);
      return agentIDs;
    } else
      return _attachOne.call(this, agents, targets, source);
  };
  PhysicsEngine.prototype.attachTo = function attachTo(agentID, target) {
    _getAgentData.call(this, agentID).targets.push(target);
  };
  PhysicsEngine.prototype.detach = function detach(id) {
    var agent = this.getAgent(id);
    var agentArray = _mapAgentArray.call(this, agent);
    var index = agentArray.indexOf(id);
    agentArray.splice(index, 1);
    delete this._agentData[id];
  };
  PhysicsEngine.prototype.detachFrom = function detachFrom(id, target) {
    var boundAgent = _getAgentData.call(this, id);
    if (boundAgent.source === target)
      this.detach(id);
    else {
      var targets = boundAgent.targets;
      var index = targets.indexOf(target);
      if (index > -1)
        targets.splice(index, 1);
    }
  };
  PhysicsEngine.prototype.detachAll = function detachAll() {
    this._agentData = {};
    this._forces = [];
    this._constraints = [];
    this._currAgentId = 0;
  };
  function _getAgentData(id) {
    return this._agentData[id];
  }
  PhysicsEngine.prototype.getAgent = function getAgent(id) {
    return _getAgentData.call(this, id).agent;
  };
  PhysicsEngine.prototype.getParticles = function getParticles() {
    return this._particles;
  };
  PhysicsEngine.prototype.getBodies = function getBodies() {
    return this._bodies;
  };
  PhysicsEngine.prototype.getParticlesAndBodies = function getParticlesAndBodies() {
    return this.getParticles().concat(this.getBodies());
  };
  PhysicsEngine.prototype.forEachParticle = function forEachParticle(fn, dt) {
    var particles = this.getParticles();
    for (var index = 0,
        len = particles.length; index < len; index++)
      fn.call(this, particles[index], dt);
  };
  PhysicsEngine.prototype.forEachBody = function forEachBody(fn, dt) {
    if (!this._hasBodies)
      return ;
    var bodies = this.getBodies();
    for (var index = 0,
        len = bodies.length; index < len; index++)
      fn.call(this, bodies[index], dt);
  };
  PhysicsEngine.prototype.forEach = function forEach(fn, dt) {
    this.forEachParticle(fn, dt);
    this.forEachBody(fn, dt);
  };
  function _updateForce(index) {
    var boundAgent = _getAgentData.call(this, this._forces[index]);
    boundAgent.agent.applyForce(boundAgent.targets, boundAgent.source);
  }
  function _updateForces() {
    for (var index = this._forces.length - 1; index > -1; index--)
      _updateForce.call(this, index);
  }
  function _updateConstraint(index, dt) {
    var boundAgent = this._agentData[this._constraints[index]];
    return boundAgent.agent.applyConstraint(boundAgent.targets, boundAgent.source, dt);
  }
  function _updateConstraints(dt) {
    var iteration = 0;
    while (iteration < this.options.constraintSteps) {
      for (var index = this._constraints.length - 1; index > -1; index--)
        _updateConstraint.call(this, index, dt);
      iteration++;
    }
  }
  function _updateVelocities(body, dt) {
    body.integrateVelocity(dt);
    if (this.options.velocityCap)
      body.velocity.cap(this.options.velocityCap).put(body.velocity);
  }
  function _updateAngularVelocities(body, dt) {
    body.integrateAngularMomentum(dt);
    body.updateAngularVelocity();
    if (this.options.angularVelocityCap)
      body.angularVelocity.cap(this.options.angularVelocityCap).put(body.angularVelocity);
  }
  function _updateOrientations(body, dt) {
    body.integrateOrientation(dt);
  }
  function _updatePositions(body, dt) {
    body.integratePosition(dt);
    body.emit(_events.update, body);
  }
  function _integrate(dt) {
    _updateForces.call(this, dt);
    this.forEach(_updateVelocities, dt);
    this.forEachBody(_updateAngularVelocities, dt);
    _updateConstraints.call(this, dt);
    this.forEachBody(_updateOrientations, dt);
    this.forEach(_updatePositions, dt);
  }
  function _getParticlesEnergy() {
    var energy = 0;
    var particleEnergy = 0;
    this.forEach(function(particle) {
      particleEnergy = particle.getEnergy();
      energy += particleEnergy;
    });
    return energy;
  }
  function _getAgentsEnergy() {
    var energy = 0;
    for (var id in this._agentData)
      energy += this.getAgentEnergy(id);
    return energy;
  }
  PhysicsEngine.prototype.getAgentEnergy = function(agentId) {
    var agentData = _getAgentData.call(this, agentId);
    return agentData.agent.getEnergy(agentData.targets, agentData.source);
  };
  PhysicsEngine.prototype.getEnergy = function getEnergy() {
    return _getParticlesEnergy.call(this) + _getAgentsEnergy.call(this);
  };
  PhysicsEngine.prototype.step = function step() {
    if (this.isSleeping())
      return ;
    var currTime = now();
    var dtFrame = currTime - this._prevTime;
    this._prevTime = currTime;
    if (dtFrame < MIN_TIME_STEP)
      return ;
    if (dtFrame > MAX_TIME_STEP)
      dtFrame = MAX_TIME_STEP;
    _integrate.call(this, TIMESTEP);
    this.emit(_events.update, this);
    if (this.getEnergy() < this.options.sleepTolerance)
      this.sleep();
  };
  PhysicsEngine.prototype.isSleeping = function isSleeping() {
    return this._isSleeping;
  };
  PhysicsEngine.prototype.isActive = function isSleeping() {
    return !this._isSleeping;
  };
  PhysicsEngine.prototype.sleep = function sleep() {
    if (this._isSleeping)
      return ;
    this.forEach(function(body) {
      body.sleep();
    });
    this.emit(_events.end, this);
    this._isSleeping = true;
  };
  PhysicsEngine.prototype.wake = function wake() {
    if (!this._isSleeping)
      return ;
    this._prevTime = now();
    this.emit(_events.start, this);
    this._isSleeping = false;
  };
  PhysicsEngine.prototype.emit = function emit(type, data) {
    if (this._eventHandler === null)
      return ;
    this._eventHandler.emit(type, data);
  };
  PhysicsEngine.prototype.on = function on(event, fn) {
    if (this._eventHandler === null)
      this._eventHandler = new EventHandler();
    this._eventHandler.on(event, fn);
  };
  module.exports = PhysicsEngine;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/physics/integrators/SymplecticEuler", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var SymplecticEuler = {};
  SymplecticEuler.integrateVelocity = function integrateVelocity(body, dt) {
    var v = body.velocity;
    var w = body.inverseMass;
    var f = body.force;
    if (f.isZero())
      return ;
    v.add(f.mult(dt * w)).put(v);
    f.clear();
  };
  SymplecticEuler.integratePosition = function integratePosition(body, dt) {
    var p = body.position;
    var v = body.velocity;
    p.add(v.mult(dt)).put(p);
  };
  SymplecticEuler.integrateAngularMomentum = function integrateAngularMomentum(body, dt) {
    var L = body.angularMomentum;
    var t = body.torque;
    if (t.isZero())
      return ;
    L.add(t.mult(dt)).put(L);
    t.clear();
  };
  SymplecticEuler.integrateOrientation = function integrateOrientation(body, dt) {
    var q = body.orientation;
    var w = body.angularVelocity;
    if (w.isZero())
      return ;
    q.add(q.multiply(w).scalarMultiply(0.5 * dt)).put(q);
  };
  module.exports = SymplecticEuler;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/physics/bodies/Circle", ["npm:famous@0.3.5/physics/bodies/Body", "npm:famous@0.3.5/math/Matrix"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var Body = require("npm:famous@0.3.5/physics/bodies/Body");
  var Matrix = require("npm:famous@0.3.5/math/Matrix");
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
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/physics/bodies/Rectangle", ["npm:famous@0.3.5/physics/bodies/Body", "npm:famous@0.3.5/math/Matrix"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var Body = require("npm:famous@0.3.5/physics/bodies/Body");
  var Matrix = require("npm:famous@0.3.5/math/Matrix");
  function Rectangle(options) {
    options = options || {};
    this.size = options.size || [0, 0];
    Body.call(this, options);
  }
  Rectangle.prototype = Object.create(Body.prototype);
  Rectangle.prototype.constructor = Rectangle;
  Rectangle.prototype.setSize = function setSize(size) {
    this.size = size;
    this.setMomentsOfInertia();
  };
  Rectangle.prototype.setMomentsOfInertia = function setMomentsOfInertia() {
    var m = this.mass;
    var w = this.size[0];
    var h = this.size[1];
    this.inertia = new Matrix([[m * h * h / 12, 0, 0], [0, m * w * w / 12, 0], [0, 0, m * (w * w + h * h) / 12]]);
    this.inverseInertia = new Matrix([[12 / (m * h * h), 0, 0], [0, 12 / (m * w * w), 0], [0, 0, 12 / (m * (w * w + h * h))]]);
  };
  module.exports = Rectangle;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/physics/constraints/Constraint", ["npm:famous@0.3.5/core/EventHandler"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var EventHandler = require("npm:famous@0.3.5/core/EventHandler");
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
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/physics/constraints/Curve", ["npm:famous@0.3.5/physics/constraints/Constraint", "npm:famous@0.3.5/math/Vector"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var Constraint = require("npm:famous@0.3.5/physics/constraints/Constraint");
  var Vector = require("npm:famous@0.3.5/math/Vector");
  function Curve(options) {
    this.options = Object.create(Curve.DEFAULT_OPTIONS);
    if (options)
      this.setOptions(options);
    this.J = new Vector();
    this.impulse = new Vector();
    Constraint.call(this);
  }
  Curve.prototype = Object.create(Constraint.prototype);
  Curve.prototype.constructor = Curve;
  var epsilon = 1e-7;
  var pi = Math.PI;
  Curve.DEFAULT_OPTIONS = {
    equation: function(x, y, z) {
      return 0;
    },
    plane: function(x, y, z) {
      return z;
    },
    period: 0,
    dampingRatio: 0
  };
  Curve.prototype.setOptions = function setOptions(options) {
    for (var key in options)
      this.options[key] = options[key];
  };
  Curve.prototype.applyConstraint = function applyConstraint(targets, source, dt) {
    var options = this.options;
    var impulse = this.impulse;
    var J = this.J;
    var f = options.equation;
    var g = options.plane;
    var dampingRatio = options.dampingRatio;
    var period = options.period;
    for (var i = 0; i < targets.length; i++) {
      var body = targets[i];
      var v = body.velocity;
      var p = body.position;
      var m = body.mass;
      var gamma;
      var beta;
      if (period === 0) {
        gamma = 0;
        beta = 1;
      } else {
        var c = 4 * m * pi * dampingRatio / period;
        var k = 4 * m * pi * pi / (period * period);
        gamma = 1 / (c + dt * k);
        beta = dt * k / (c + dt * k);
      }
      var x = p.x;
      var y = p.y;
      var z = p.z;
      var f0 = f(x, y, z);
      var dfx = (f(x + epsilon, y, z) - f0) / epsilon;
      var dfy = (f(x, y + epsilon, z) - f0) / epsilon;
      var dfz = (f(x, y, z + epsilon) - f0) / epsilon;
      var g0 = g(x, y, z);
      var dgx = (g(x + epsilon, y, z) - g0) / epsilon;
      var dgy = (g(x, y + epsilon, z) - g0) / epsilon;
      var dgz = (g(x, y, z + epsilon) - g0) / epsilon;
      J.setXYZ(dfx + dgx, dfy + dgy, dfz + dgz);
      var antiDrift = beta / dt * (f0 + g0);
      var lambda = -(J.dot(v) + antiDrift) / (gamma + dt * J.normSquared() / m);
      impulse.set(J.mult(dt * lambda));
      body.applyImpulse(impulse);
    }
  };
  module.exports = Curve;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/physics/constraints/Distance", ["npm:famous@0.3.5/physics/constraints/Constraint", "npm:famous@0.3.5/math/Vector"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var Constraint = require("npm:famous@0.3.5/physics/constraints/Constraint");
  var Vector = require("npm:famous@0.3.5/math/Vector");
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
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/physics/constraints/Snap", ["npm:famous@0.3.5/physics/constraints/Constraint", "npm:famous@0.3.5/math/Vector"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var Constraint = require("npm:famous@0.3.5/physics/constraints/Constraint");
  var Vector = require("npm:famous@0.3.5/math/Vector");
  function Snap(options) {
    Constraint.call(this);
    this.options = Object.create(this.constructor.DEFAULT_OPTIONS);
    if (options)
      this.setOptions(options);
    this.pDiff = new Vector();
    this.vDiff = new Vector();
    this.impulse1 = new Vector();
    this.impulse2 = new Vector();
  }
  Snap.prototype = Object.create(Constraint.prototype);
  Snap.prototype.constructor = Snap;
  Snap.DEFAULT_OPTIONS = {
    period: 300,
    dampingRatio: 0.1,
    length: 0,
    anchor: undefined
  };
  var pi = Math.PI;
  Snap.prototype.setOptions = function setOptions(options) {
    if (options.anchor !== undefined) {
      if (options.anchor instanceof Vector)
        this.options.anchor = options.anchor;
      if (options.anchor.position instanceof Vector)
        this.options.anchor = options.anchor.position;
      if (options.anchor instanceof Array)
        this.options.anchor = new Vector(options.anchor);
    }
    if (options.length !== undefined)
      this.options.length = options.length;
    if (options.dampingRatio !== undefined)
      this.options.dampingRatio = options.dampingRatio;
    if (options.period !== undefined)
      this.options.period = options.period;
    Constraint.prototype.setOptions.call(this, options);
  };
  Snap.prototype.getEnergy = function getEnergy(targets, source) {
    var options = this.options;
    var restLength = options.length;
    var anchor = options.anchor || source.position;
    var strength = Math.pow(2 * pi / options.period, 2);
    var energy = 0;
    for (var i = 0; i < targets.length; i++) {
      var target = targets[i];
      var dist = anchor.sub(target.position).norm() - restLength;
      energy += 0.5 * strength * dist * dist;
    }
    return energy;
  };
  Snap.prototype.applyConstraint = function applyConstraint(targets, source, dt) {
    var options = this.options;
    var pDiff = this.pDiff;
    var vDiff = this.vDiff;
    var impulse1 = this.impulse1;
    var impulse2 = this.impulse2;
    var length = options.length;
    var anchor = options.anchor || source.position;
    var period = options.period;
    var dampingRatio = options.dampingRatio;
    for (var i = 0; i < targets.length; i++) {
      var target = targets[i];
      var p1 = target.position;
      var v1 = target.velocity;
      var m1 = target.mass;
      var w1 = target.inverseMass;
      pDiff.set(p1.sub(anchor));
      var dist = pDiff.norm() - length;
      var effMass;
      if (source) {
        var w2 = source.inverseMass;
        var v2 = source.velocity;
        vDiff.set(v1.sub(v2));
        effMass = 1 / (w1 + w2);
      } else {
        vDiff.set(v1);
        effMass = m1;
      }
      var gamma;
      var beta;
      if (this.options.period === 0) {
        gamma = 0;
        beta = 1;
      } else {
        var k = 4 * effMass * pi * pi / (period * period);
        var c = 4 * effMass * pi * dampingRatio / period;
        beta = dt * k / (c + dt * k);
        gamma = 1 / (c + dt * k);
      }
      var antiDrift = beta / dt * dist;
      pDiff.normalize(-antiDrift).sub(vDiff).mult(dt / (gamma + dt / effMass)).put(impulse1);
      target.applyImpulse(impulse1);
      if (source) {
        impulse1.mult(-1).put(impulse2);
        source.applyImpulse(impulse2);
      }
    }
  };
  module.exports = Snap;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/physics/constraints/Surface", ["npm:famous@0.3.5/physics/constraints/Constraint", "npm:famous@0.3.5/math/Vector"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var Constraint = require("npm:famous@0.3.5/physics/constraints/Constraint");
  var Vector = require("npm:famous@0.3.5/math/Vector");
  function Surface(options) {
    this.options = Object.create(Surface.DEFAULT_OPTIONS);
    if (options)
      this.setOptions(options);
    this.J = new Vector();
    this.impulse = new Vector();
    Constraint.call(this);
  }
  Surface.prototype = Object.create(Constraint.prototype);
  Surface.prototype.constructor = Surface;
  Surface.DEFAULT_OPTIONS = {
    equation: undefined,
    period: 0,
    dampingRatio: 0
  };
  var epsilon = 1e-7;
  var pi = Math.PI;
  Surface.prototype.setOptions = function setOptions(options) {
    for (var key in options)
      this.options[key] = options[key];
  };
  Surface.prototype.applyConstraint = function applyConstraint(targets, source, dt) {
    var impulse = this.impulse;
    var J = this.J;
    var options = this.options;
    var f = options.equation;
    var dampingRatio = options.dampingRatio;
    var period = options.period;
    for (var i = 0; i < targets.length; i++) {
      var particle = targets[i];
      var v = particle.velocity;
      var p = particle.position;
      var m = particle.mass;
      var gamma;
      var beta;
      if (period === 0) {
        gamma = 0;
        beta = 1;
      } else {
        var c = 4 * m * pi * dampingRatio / period;
        var k = 4 * m * pi * pi / (period * period);
        gamma = 1 / (c + dt * k);
        beta = dt * k / (c + dt * k);
      }
      var x = p.x;
      var y = p.y;
      var z = p.z;
      var f0 = f(x, y, z);
      var dfx = (f(x + epsilon, p, p) - f0) / epsilon;
      var dfy = (f(x, y + epsilon, p) - f0) / epsilon;
      var dfz = (f(x, y, p + epsilon) - f0) / epsilon;
      J.setXYZ(dfx, dfy, dfz);
      var antiDrift = beta / dt * f0;
      var lambda = -(J.dot(v) + antiDrift) / (gamma + dt * J.normSquared() / m);
      impulse.set(J.mult(dt * lambda));
      particle.applyImpulse(impulse);
    }
  };
  module.exports = Surface;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/physics/constraints/Wall", ["npm:famous@0.3.5/physics/constraints/Constraint", "npm:famous@0.3.5/math/Vector"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var Constraint = require("npm:famous@0.3.5/physics/constraints/Constraint");
  var Vector = require("npm:famous@0.3.5/math/Vector");
  function Wall(options) {
    this.options = Object.create(Wall.DEFAULT_OPTIONS);
    if (options)
      this.setOptions(options);
    this.diff = new Vector();
    this.impulse = new Vector();
    Constraint.call(this);
  }
  Wall.prototype = Object.create(Constraint.prototype);
  Wall.prototype.constructor = Wall;
  Wall.ON_CONTACT = {
    REFLECT: 0,
    SILENT: 1
  };
  Wall.DEFAULT_OPTIONS = {
    restitution: 0.5,
    drift: 0.5,
    slop: 0,
    normal: [1, 0, 0],
    distance: 0,
    onContact: Wall.ON_CONTACT.REFLECT
  };
  Wall.prototype.setOptions = function setOptions(options) {
    if (options.normal !== undefined) {
      if (options.normal instanceof Vector)
        this.options.normal = options.normal.clone();
      if (options.normal instanceof Array)
        this.options.normal = new Vector(options.normal);
    }
    if (options.restitution !== undefined)
      this.options.restitution = options.restitution;
    if (options.drift !== undefined)
      this.options.drift = options.drift;
    if (options.slop !== undefined)
      this.options.slop = options.slop;
    if (options.distance !== undefined)
      this.options.distance = options.distance;
    if (options.onContact !== undefined)
      this.options.onContact = options.onContact;
  };
  function _getNormalVelocity(n, v) {
    return v.dot(n);
  }
  function _getDistanceFromOrigin(p) {
    var n = this.options.normal;
    var d = this.options.distance;
    return p.dot(n) + d;
  }
  function _onEnter(particle, overlap, dt) {
    var p = particle.position;
    var v = particle.velocity;
    var m = particle.mass;
    var n = this.options.normal;
    var action = this.options.onContact;
    var restitution = this.options.restitution;
    var impulse = this.impulse;
    var drift = this.options.drift;
    var slop = -this.options.slop;
    var gamma = 0;
    if (this._eventOutput) {
      var data = {
        particle: particle,
        wall: this,
        overlap: overlap,
        normal: n
      };
      this._eventOutput.emit('preCollision', data);
      this._eventOutput.emit('collision', data);
    }
    switch (action) {
      case Wall.ON_CONTACT.REFLECT:
        var lambda = overlap < slop ? -((1 + restitution) * n.dot(v) + drift / dt * (overlap - slop)) / (m * dt + gamma) : -((1 + restitution) * n.dot(v)) / (m * dt + gamma);
        impulse.set(n.mult(dt * lambda));
        particle.applyImpulse(impulse);
        particle.setPosition(p.add(n.mult(-overlap)));
        break;
    }
    if (this._eventOutput)
      this._eventOutput.emit('postCollision', data);
  }
  function _onExit(particle, overlap, dt) {
    var action = this.options.onContact;
    var p = particle.position;
    var n = this.options.normal;
    if (action === Wall.ON_CONTACT.REFLECT) {
      particle.setPosition(p.add(n.mult(-overlap)));
    }
  }
  Wall.prototype.applyConstraint = function applyConstraint(targets, source, dt) {
    var n = this.options.normal;
    for (var i = 0; i < targets.length; i++) {
      var particle = targets[i];
      var p = particle.position;
      var v = particle.velocity;
      var r = particle.radius || 0;
      var overlap = _getDistanceFromOrigin.call(this, p.add(n.mult(-r)));
      var nv = _getNormalVelocity.call(this, n, v);
      if (overlap <= 0) {
        if (nv < 0)
          _onEnter.call(this, particle, overlap, dt);
        else
          _onExit.call(this, particle, overlap, dt);
      }
    }
  };
  module.exports = Wall;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/physics/constraints/Walls", ["npm:famous@0.3.5/physics/constraints/Constraint", "npm:famous@0.3.5/physics/constraints/Wall", "npm:famous@0.3.5/math/Vector"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var Constraint = require("npm:famous@0.3.5/physics/constraints/Constraint");
  var Wall = require("npm:famous@0.3.5/physics/constraints/Wall");
  var Vector = require("npm:famous@0.3.5/math/Vector");
  function Walls(options) {
    this.options = Object.create(Walls.DEFAULT_OPTIONS);
    if (options)
      this.setOptions(options);
    _createComponents.call(this, options.sides || this.options.sides);
    Constraint.call(this);
  }
  Walls.prototype = Object.create(Constraint.prototype);
  Walls.prototype.constructor = Walls;
  Walls.ON_CONTACT = Wall.ON_CONTACT;
  Walls.SIDES = {
    LEFT: 0,
    RIGHT: 1,
    TOP: 2,
    BOTTOM: 3,
    FRONT: 4,
    BACK: 5,
    TWO_DIMENSIONAL: [0, 1, 2, 3],
    THREE_DIMENSIONAL: [0, 1, 2, 3, 4, 5]
  };
  Walls.DEFAULT_OPTIONS = {
    sides: Walls.SIDES.TWO_DIMENSIONAL,
    size: [window.innerWidth, window.innerHeight, 0],
    origin: [0.5, 0.5, 0.5],
    drift: 0.5,
    slop: 0,
    restitution: 0.5,
    onContact: Walls.ON_CONTACT.REFLECT
  };
  var _SIDE_NORMALS = {
    0: new Vector(1, 0, 0),
    1: new Vector(-1, 0, 0),
    2: new Vector(0, 1, 0),
    3: new Vector(0, -1, 0),
    4: new Vector(0, 0, 1),
    5: new Vector(0, 0, -1)
  };
  function _getDistance(side, size, origin) {
    var distance;
    var SIDES = Walls.SIDES;
    switch (parseInt(side)) {
      case SIDES.LEFT:
        distance = size[0] * origin[0];
        break;
      case SIDES.TOP:
        distance = size[1] * origin[1];
        break;
      case SIDES.FRONT:
        distance = size[2] * origin[2];
        break;
      case SIDES.RIGHT:
        distance = size[0] * (1 - origin[0]);
        break;
      case SIDES.BOTTOM:
        distance = size[1] * (1 - origin[1]);
        break;
      case SIDES.BACK:
        distance = size[2] * (1 - origin[2]);
        break;
    }
    return distance;
  }
  Walls.prototype.setOptions = function setOptions(options) {
    var resizeFlag = false;
    if (options.restitution !== undefined)
      _setOptionsForEach.call(this, {restitution: options.restitution});
    if (options.drift !== undefined)
      _setOptionsForEach.call(this, {drift: options.drift});
    if (options.slop !== undefined)
      _setOptionsForEach.call(this, {slop: options.slop});
    if (options.onContact !== undefined)
      _setOptionsForEach.call(this, {onContact: options.onContact});
    if (options.size !== undefined)
      resizeFlag = true;
    if (options.sides !== undefined)
      this.options.sides = options.sides;
    if (options.origin !== undefined)
      resizeFlag = true;
    if (resizeFlag)
      this.setSize(options.size, options.origin);
  };
  function _createComponents(sides) {
    this.components = {};
    var components = this.components;
    for (var i = 0; i < sides.length; i++) {
      var side = sides[i];
      components[i] = new Wall({
        normal: _SIDE_NORMALS[side].clone(),
        distance: _getDistance(side, this.options.size, this.options.origin)
      });
    }
  }
  Walls.prototype.setSize = function setSize(size, origin) {
    origin = origin || this.options.origin;
    if (origin.length < 3)
      origin[2] = 0.5;
    this.forEach(function(wall, side) {
      var d = _getDistance(side, size, origin);
      wall.setOptions({distance: d});
    });
    this.options.size = size;
    this.options.origin = origin;
  };
  function _setOptionsForEach(options) {
    this.forEach(function(wall) {
      wall.setOptions(options);
    });
    for (var key in options)
      this.options[key] = options[key];
  }
  Walls.prototype.applyConstraint = function applyConstraint(targets, source, dt) {
    this.forEach(function(wall) {
      wall.applyConstraint(targets, source, dt);
    });
  };
  Walls.prototype.forEach = function forEach(fn) {
    var sides = this.options.sides;
    for (var key in this.sides)
      fn(sides[key], key);
  };
  Walls.prototype.rotateZ = function rotateZ(angle) {
    this.forEach(function(wall) {
      var n = wall.options.normal;
      n.rotateZ(angle).put(n);
    });
  };
  Walls.prototype.rotateX = function rotateX(angle) {
    this.forEach(function(wall) {
      var n = wall.options.normal;
      n.rotateX(angle).put(n);
    });
  };
  Walls.prototype.rotateY = function rotateY(angle) {
    this.forEach(function(wall) {
      var n = wall.options.normal;
      n.rotateY(angle).put(n);
    });
  };
  Walls.prototype.reset = function reset() {
    var sides = this.options.sides;
    for (var i in sides) {
      var component = this.components[i];
      component.options.normal.set(_SIDE_NORMALS[i]);
    }
  };
  module.exports = Walls;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/physics/forces/Force", ["npm:famous@0.3.5/math/Vector", "npm:famous@0.3.5/core/EventHandler"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var Vector = require("npm:famous@0.3.5/math/Vector");
  var EventHandler = require("npm:famous@0.3.5/core/EventHandler");
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
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/physics/forces/Repulsion", ["npm:famous@0.3.5/physics/forces/Force", "npm:famous@0.3.5/math/Vector"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var Force = require("npm:famous@0.3.5/physics/forces/Force");
  var Vector = require("npm:famous@0.3.5/math/Vector");
  function Repulsion(options) {
    this.options = Object.create(Repulsion.DEFAULT_OPTIONS);
    if (options)
      this.setOptions(options);
    this.disp = new Vector();
    Force.call(this);
  }
  Repulsion.prototype = Object.create(Force.prototype);
  Repulsion.prototype.constructor = Repulsion;
  Repulsion.DECAY_FUNCTIONS = {
    LINEAR: function(r, cutoff) {
      return Math.max(1 - 1 / cutoff * r, 0);
    },
    MORSE: function(r, cutoff) {
      var r0 = cutoff === 0 ? 100 : cutoff;
      var rShifted = r + r0 * (1 - Math.log(2));
      return Math.max(1 - Math.pow(1 - Math.exp(rShifted / r0 - 1), 2), 0);
    },
    INVERSE: function(r, cutoff) {
      return 1 / (1 - cutoff + r);
    },
    GRAVITY: function(r, cutoff) {
      return 1 / (1 - cutoff + r * r);
    }
  };
  Repulsion.DEFAULT_OPTIONS = {
    strength: 1,
    anchor: undefined,
    range: [0, Infinity],
    cutoff: 0,
    cap: Infinity,
    decayFunction: Repulsion.DECAY_FUNCTIONS.GRAVITY
  };
  Repulsion.prototype.setOptions = function setOptions(options) {
    if (options.anchor !== undefined) {
      if (options.anchor.position instanceof Vector)
        this.options.anchor = options.anchor.position;
      if (options.anchor instanceof Array)
        this.options.anchor = new Vector(options.anchor);
      delete options.anchor;
    }
    for (var key in options)
      this.options[key] = options[key];
  };
  Repulsion.prototype.applyForce = function applyForce(targets, source) {
    var options = this.options;
    var force = this.force;
    var disp = this.disp;
    var strength = options.strength;
    var anchor = options.anchor || source.position;
    var cap = options.cap;
    var cutoff = options.cutoff;
    var rMin = options.range[0];
    var rMax = options.range[1];
    var decayFn = options.decayFunction;
    if (strength === 0)
      return ;
    var length = targets.length;
    var particle;
    var m1;
    var p1;
    var r;
    while (length--) {
      particle = targets[length];
      if (particle === source)
        continue;
      m1 = particle.mass;
      p1 = particle.position;
      disp.set(p1.sub(anchor));
      r = disp.norm();
      if (r < rMax && r > rMin) {
        force.set(disp.normalize(strength * m1 * decayFn(r, cutoff)).cap(cap));
        particle.applyForce(force);
      }
    }
  };
  module.exports = Repulsion;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/physics/forces/RotationalDrag", ["npm:famous@0.3.5/physics/forces/Drag"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var Drag = require("npm:famous@0.3.5/physics/forces/Drag");
  function RotationalDrag(options) {
    Drag.call(this, options);
  }
  RotationalDrag.prototype = Object.create(Drag.prototype);
  RotationalDrag.prototype.constructor = RotationalDrag;
  RotationalDrag.DEFAULT_OPTIONS = Drag.DEFAULT_OPTIONS;
  RotationalDrag.FORCE_FUNCTIONS = Drag.FORCE_FUNCTIONS;
  RotationalDrag.FORCE_FUNCTIONS = {
    LINEAR: function(angularVelocity) {
      return angularVelocity;
    },
    QUADRATIC: function(angularVelocity) {
      return angularVelocity.mult(angularVelocity.norm());
    }
  };
  RotationalDrag.prototype.applyForce = function applyForce(targets) {
    var strength = this.options.strength;
    var forceFunction = this.options.forceFunction;
    var force = this.force;
    var index;
    var particle;
    for (index = 0; index < targets.length; index++) {
      particle = targets[index];
      forceFunction(particle.angularVelocity).mult(-100 * strength).put(force);
      particle.applyTorque(force);
    }
  };
  RotationalDrag.prototype.setOptions = function setOptions(options) {
    for (var key in options)
      this.options[key] = options[key];
  };
  module.exports = RotationalDrag;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/physics/forces/Spring", ["npm:famous@0.3.5/physics/forces/Force", "npm:famous@0.3.5/math/Vector"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var Force = require("npm:famous@0.3.5/physics/forces/Force");
  var Vector = require("npm:famous@0.3.5/math/Vector");
  function Spring(options) {
    Force.call(this);
    this.options = Object.create(this.constructor.DEFAULT_OPTIONS);
    if (options)
      this.setOptions(options);
    this.disp = new Vector(0, 0, 0);
    _init.call(this);
  }
  Spring.prototype = Object.create(Force.prototype);
  Spring.prototype.constructor = Spring;
  var pi = Math.PI;
  var MIN_PERIOD = 150;
  Spring.FORCE_FUNCTIONS = {
    FENE: function(dist, rMax) {
      var rMaxSmall = rMax * 0.99;
      var r = Math.max(Math.min(dist, rMaxSmall), -rMaxSmall);
      return r / (1 - r * r / (rMax * rMax));
    },
    HOOK: function(dist) {
      return dist;
    }
  };
  Spring.DEFAULT_OPTIONS = {
    period: 300,
    dampingRatio: 0.1,
    length: 0,
    maxLength: Infinity,
    anchor: undefined,
    forceFunction: Spring.FORCE_FUNCTIONS.HOOK
  };
  function _calcStiffness() {
    var options = this.options;
    options.stiffness = Math.pow(2 * pi / options.period, 2);
  }
  function _calcDamping() {
    var options = this.options;
    options.damping = 4 * pi * options.dampingRatio / options.period;
  }
  function _init() {
    _calcStiffness.call(this);
    _calcDamping.call(this);
  }
  Spring.prototype.setOptions = function setOptions(options) {
    if (options.anchor !== undefined) {
      if (options.anchor.position instanceof Vector)
        this.options.anchor = options.anchor.position;
      if (options.anchor instanceof Vector)
        this.options.anchor = options.anchor;
      if (options.anchor instanceof Array)
        this.options.anchor = new Vector(options.anchor);
    }
    if (options.period !== undefined) {
      if (options.period < MIN_PERIOD) {
        options.period = MIN_PERIOD;
        console.warn('The period of a SpringTransition is capped at ' + MIN_PERIOD + ' ms. Use a SnapTransition for faster transitions');
      }
      this.options.period = options.period;
    }
    if (options.dampingRatio !== undefined)
      this.options.dampingRatio = options.dampingRatio;
    if (options.length !== undefined)
      this.options.length = options.length;
    if (options.forceFunction !== undefined)
      this.options.forceFunction = options.forceFunction;
    if (options.maxLength !== undefined)
      this.options.maxLength = options.maxLength;
    _init.call(this);
    Force.prototype.setOptions.call(this, options);
  };
  Spring.prototype.applyForce = function applyForce(targets, source) {
    var force = this.force;
    var disp = this.disp;
    var options = this.options;
    var stiffness = options.stiffness;
    var damping = options.damping;
    var restLength = options.length;
    var maxLength = options.maxLength;
    var anchor = options.anchor || source.position;
    var forceFunction = options.forceFunction;
    var i;
    var target;
    var p2;
    var v2;
    var dist;
    var m;
    for (i = 0; i < targets.length; i++) {
      target = targets[i];
      p2 = target.position;
      v2 = target.velocity;
      anchor.sub(p2).put(disp);
      dist = disp.norm() - restLength;
      if (dist === 0)
        return ;
      m = target.mass;
      stiffness *= m;
      damping *= m;
      disp.normalize(stiffness * forceFunction(dist, maxLength)).put(force);
      if (damping)
        if (source)
          force.add(v2.sub(source.velocity).mult(-damping)).put(force);
        else
          force.add(v2.mult(-damping)).put(force);
      target.applyForce(force);
      if (source)
        source.applyForce(force.mult(-1));
    }
  };
  Spring.prototype.getEnergy = function getEnergy(targets, source) {
    var options = this.options;
    var restLength = options.length;
    var anchor = source ? source.position : options.anchor;
    var strength = options.stiffness;
    var energy = 0;
    for (var i = 0; i < targets.length; i++) {
      var target = targets[i];
      var dist = anchor.sub(target.position).norm() - restLength;
      energy += 0.5 * strength * dist * dist;
    }
    return energy;
  };
  module.exports = Spring;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/physics/forces/VectorField", ["npm:famous@0.3.5/physics/forces/Force", "npm:famous@0.3.5/math/Vector"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var Force = require("npm:famous@0.3.5/physics/forces/Force");
  var Vector = require("npm:famous@0.3.5/math/Vector");
  function VectorField(options) {
    Force.call(this);
    this.options = Object.create(VectorField.DEFAULT_OPTIONS);
    if (options)
      this.setOptions(options);
    this.evaluation = new Vector();
  }
  VectorField.prototype = Object.create(Force.prototype);
  VectorField.prototype.constructor = VectorField;
  VectorField.FIELDS = {
    CONSTANT: function(v, options) {
      options.direction.put(this.evaluation);
    },
    LINEAR: function(v) {
      v.put(this.evaluation);
    },
    RADIAL: function(v) {
      v.mult(-1).put(this.evaluation);
    },
    POINT_ATTRACTOR: function(v, options) {
      options.position.sub(v).put(this.evaluation);
    }
  };
  VectorField.DEFAULT_OPTIONS = {
    strength: 0.01,
    field: VectorField.FIELDS.CONSTANT
  };
  VectorField.prototype.setOptions = function setOptions(options) {
    if (options.strength !== undefined)
      this.options.strength = options.strength;
    if (options.direction !== undefined)
      this.options.direction = options.direction;
    if (options.field !== undefined) {
      this.options.field = options.field;
      _setFieldOptions.call(this, this.options.field);
    }
  };
  function _setFieldOptions(field) {
    var FIELDS = VectorField.FIELDS;
    switch (field) {
      case FIELDS.CONSTANT:
        if (!this.options.direction)
          this.options.direction = new Vector(0, 1, 0);
        else if (this.options.direction instanceof Array)
          this.options.direction = new Vector(this.options.direction);
        break;
      case FIELDS.POINT_ATTRACTOR:
        if (!this.options.position)
          this.options.position = new Vector(0, 0, 0);
        else if (this.options.position instanceof Array)
          this.options.position = new Vector(this.options.position);
        break;
    }
  }
  VectorField.prototype.applyForce = function applyForce(targets) {
    var force = this.force;
    var strength = this.options.strength;
    var field = this.options.field;
    var i;
    var target;
    for (i = 0; i < targets.length; i++) {
      target = targets[i];
      field.call(this, target.position, this.options);
      this.evaluation.mult(target.mass * strength).put(force);
      target.applyForce(force);
    }
  };
  VectorField.prototype.getEnergy = function getEnergy(targets) {
    var field = this.options.field;
    var FIELDS = VectorField.FIELDS;
    var energy = 0;
    var i;
    var target;
    switch (field) {
      case FIELDS.CONSTANT:
        energy = targets.length * this.options.direction.norm();
        break;
      case FIELDS.RADIAL:
        for (i = 0; i < targets.length; i++) {
          target = targets[i];
          energy += target.position.norm();
        }
        break;
      case FIELDS.POINT_ATTRACTOR:
        for (i = 0; i < targets.length; i++) {
          target = targets[i];
          energy += target.position.sub(this.options.position).norm();
        }
        break;
    }
    energy *= this.options.strength;
    return energy;
  };
  module.exports = VectorField;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/physics/integrators/index", ["npm:famous@0.3.5/physics/integrators/SymplecticEuler"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = {SymplecticEuler: require("npm:famous@0.3.5/physics/integrators/SymplecticEuler")};
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/surfaces/CanvasSurface", ["npm:famous@0.3.5/core/Surface"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var Surface = require("npm:famous@0.3.5/core/Surface");
  function CanvasSurface(options) {
    if (options && options.canvasSize)
      this._canvasSize = options.canvasSize;
    Surface.apply(this, arguments);
    if (!this._canvasSize)
      this._canvasSize = this.getSize();
    this._backBuffer = document.createElement('canvas');
    if (this._canvasSize) {
      this._backBuffer.width = this._canvasSize[0];
      this._backBuffer.height = this._canvasSize[1];
    }
    this._contextId = undefined;
  }
  CanvasSurface.prototype = Object.create(Surface.prototype);
  CanvasSurface.prototype.constructor = CanvasSurface;
  CanvasSurface.prototype.elementType = 'canvas';
  CanvasSurface.prototype.elementClass = 'famous-surface';
  CanvasSurface.prototype.setContent = function setContent() {};
  CanvasSurface.prototype.deploy = function deploy(target) {
    if (this._canvasSize) {
      target.width = this._canvasSize[0];
      target.height = this._canvasSize[1];
    }
    if (this._contextId === '2d') {
      target.getContext(this._contextId).drawImage(this._backBuffer, 0, 0);
      this._backBuffer.width = 0;
      this._backBuffer.height = 0;
    }
  };
  CanvasSurface.prototype.recall = function recall(target) {
    var size = this.getSize();
    this._backBuffer.width = target.width;
    this._backBuffer.height = target.height;
    if (this._contextId === '2d') {
      this._backBuffer.getContext(this._contextId).drawImage(target, 0, 0);
      target.width = 0;
      target.height = 0;
    }
  };
  CanvasSurface.prototype.getContext = function getContext(contextId) {
    this._contextId = contextId;
    return this._currentTarget ? this._currentTarget.getContext(contextId) : this._backBuffer.getContext(contextId);
  };
  CanvasSurface.prototype.setSize = function setSize(size, canvasSize) {
    Surface.prototype.setSize.apply(this, arguments);
    if (canvasSize)
      this._canvasSize = [canvasSize[0], canvasSize[1]];
    if (this._currentTarget) {
      this._currentTarget.width = this._canvasSize[0];
      this._currentTarget.height = this._canvasSize[1];
    }
  };
  module.exports = CanvasSurface;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/surfaces/ContainerSurface", ["npm:famous@0.3.5/core/Surface", "npm:famous@0.3.5/core/Context"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var Surface = require("npm:famous@0.3.5/core/Surface");
  var Context = require("npm:famous@0.3.5/core/Context");
  function ContainerSurface(options) {
    Surface.call(this, options);
    this._container = document.createElement('div');
    this._container.classList.add('famous-group');
    this._container.classList.add('famous-container-group');
    this._shouldRecalculateSize = false;
    this.context = new Context(this._container);
    this.setContent(this._container);
  }
  ContainerSurface.prototype = Object.create(Surface.prototype);
  ContainerSurface.prototype.constructor = ContainerSurface;
  ContainerSurface.prototype.elementType = 'div';
  ContainerSurface.prototype.elementClass = 'famous-surface';
  ContainerSurface.prototype.add = function add() {
    return this.context.add.apply(this.context, arguments);
  };
  ContainerSurface.prototype.render = function render() {
    if (this._sizeDirty)
      this._shouldRecalculateSize = true;
    return Surface.prototype.render.apply(this, arguments);
  };
  ContainerSurface.prototype.deploy = function deploy() {
    this._shouldRecalculateSize = true;
    return Surface.prototype.deploy.apply(this, arguments);
  };
  ContainerSurface.prototype.commit = function commit(context, transform, opacity, origin, size) {
    var previousSize = this._size ? [this._size[0], this._size[1]] : null;
    var result = Surface.prototype.commit.apply(this, arguments);
    if (this._shouldRecalculateSize || previousSize && (this._size[0] !== previousSize[0] || this._size[1] !== previousSize[1])) {
      this.context.setSize();
      this._shouldRecalculateSize = false;
    }
    this.context.update();
    return result;
  };
  module.exports = ContainerSurface;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/surfaces/FormContainerSurface", ["npm:famous@0.3.5/surfaces/ContainerSurface"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var ContainerSurface = require("npm:famous@0.3.5/surfaces/ContainerSurface");
  function FormContainerSurface(options) {
    if (options)
      this._method = options.method || '';
    ContainerSurface.apply(this, arguments);
  }
  FormContainerSurface.prototype = Object.create(ContainerSurface.prototype);
  FormContainerSurface.prototype.constructor = FormContainerSurface;
  FormContainerSurface.prototype.elementType = 'form';
  FormContainerSurface.prototype.deploy = function deploy(target) {
    if (this._method)
      target.method = this._method;
    return ContainerSurface.prototype.deploy.apply(this, arguments);
  };
  module.exports = FormContainerSurface;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/surfaces/ImageSurface", ["npm:famous@0.3.5/core/Surface"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var Surface = require("npm:famous@0.3.5/core/Surface");
  function ImageSurface(options) {
    this._imageUrl = undefined;
    Surface.apply(this, arguments);
  }
  var urlCache = [];
  var countCache = [];
  var nodeCache = [];
  var cacheEnabled = true;
  ImageSurface.enableCache = function enableCache() {
    cacheEnabled = true;
  };
  ImageSurface.disableCache = function disableCache() {
    cacheEnabled = false;
  };
  ImageSurface.clearCache = function clearCache() {
    urlCache = [];
    countCache = [];
    nodeCache = [];
  };
  ImageSurface.getCache = function getCache() {
    return {
      urlCache: urlCache,
      countCache: countCache,
      nodeCache: nodeCache
    };
  };
  ImageSurface.prototype = Object.create(Surface.prototype);
  ImageSurface.prototype.constructor = ImageSurface;
  ImageSurface.prototype.elementType = 'img';
  ImageSurface.prototype.elementClass = 'famous-surface';
  ImageSurface.prototype.setContent = function setContent(imageUrl) {
    var urlIndex = urlCache.indexOf(this._imageUrl);
    if (urlIndex !== -1) {
      if (countCache[urlIndex] === 1) {
        urlCache.splice(urlIndex, 1);
        countCache.splice(urlIndex, 1);
        nodeCache.splice(urlIndex, 1);
      } else {
        countCache[urlIndex]--;
      }
    }
    urlIndex = urlCache.indexOf(imageUrl);
    if (urlIndex === -1) {
      urlCache.push(imageUrl);
      countCache.push(1);
    } else {
      countCache[urlIndex]++;
    }
    this._imageUrl = imageUrl;
    this._contentDirty = true;
  };
  ImageSurface.prototype.deploy = function deploy(target) {
    var urlIndex = urlCache.indexOf(this._imageUrl);
    if (nodeCache[urlIndex] === undefined && cacheEnabled) {
      var img = new Image();
      img.src = this._imageUrl || '';
      nodeCache[urlIndex] = img;
    }
    target.src = this._imageUrl || '';
  };
  ImageSurface.prototype.recall = function recall(target) {
    target.src = '';
  };
  module.exports = ImageSurface;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/surfaces/InputSurface", ["npm:famous@0.3.5/core/Surface"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var Surface = require("npm:famous@0.3.5/core/Surface");
  function InputSurface(options) {
    this._placeholder = options.placeholder || '';
    this._value = options.value || '';
    this._type = options.type || 'text';
    this._name = options.name || '';
    Surface.apply(this, arguments);
    this.on('click', this.focus.bind(this));
    window.addEventListener('click', function(event) {
      if (event.target !== this._currentTarget)
        this.blur();
    }.bind(this));
  }
  InputSurface.prototype = Object.create(Surface.prototype);
  InputSurface.prototype.constructor = InputSurface;
  InputSurface.prototype.elementType = 'input';
  InputSurface.prototype.elementClass = 'famous-surface';
  InputSurface.prototype.setPlaceholder = function setPlaceholder(str) {
    this._placeholder = str;
    this._contentDirty = true;
    return this;
  };
  InputSurface.prototype.focus = function focus() {
    if (this._currentTarget)
      this._currentTarget.focus();
    return this;
  };
  InputSurface.prototype.blur = function blur() {
    if (this._currentTarget)
      this._currentTarget.blur();
    return this;
  };
  InputSurface.prototype.setValue = function setValue(str) {
    this._value = str;
    this._contentDirty = true;
    return this;
  };
  InputSurface.prototype.setType = function setType(str) {
    this._type = str;
    this._contentDirty = true;
    return this;
  };
  InputSurface.prototype.getValue = function getValue() {
    if (this._currentTarget) {
      return this._currentTarget.value;
    } else {
      return this._value;
    }
  };
  InputSurface.prototype.setName = function setName(str) {
    this._name = str;
    this._contentDirty = true;
    return this;
  };
  InputSurface.prototype.getName = function getName() {
    return this._name;
  };
  InputSurface.prototype.deploy = function deploy(target) {
    if (this._placeholder !== '')
      target.placeholder = this._placeholder;
    target.value = this._value;
    target.type = this._type;
    target.name = this._name;
  };
  module.exports = InputSurface;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/surfaces/SubmitInputSurface", ["npm:famous@0.3.5/surfaces/InputSurface"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var InputSurface = require("npm:famous@0.3.5/surfaces/InputSurface");
  function SubmitInputSurface(options) {
    InputSurface.apply(this, arguments);
    this._type = 'submit';
    if (options && options.onClick)
      this.setOnClick(options.onClick);
  }
  SubmitInputSurface.prototype = Object.create(InputSurface.prototype);
  SubmitInputSurface.prototype.constructor = SubmitInputSurface;
  SubmitInputSurface.prototype.setOnClick = function(onClick) {
    this.onClick = onClick;
  };
  SubmitInputSurface.prototype.deploy = function deploy(target) {
    if (this.onclick)
      target.onClick = this.onClick;
    InputSurface.prototype.deploy.apply(this, arguments);
  };
  module.exports = SubmitInputSurface;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/surfaces/TextareaSurface", ["npm:famous@0.3.5/core/Surface"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var Surface = require("npm:famous@0.3.5/core/Surface");
  function TextareaSurface(options) {
    this._placeholder = options.placeholder || '';
    this._value = options.value || '';
    this._name = options.name || '';
    this._wrap = options.wrap || '';
    this._cols = options.cols || '';
    this._rows = options.rows || '';
    Surface.apply(this, arguments);
    this.on('click', this.focus.bind(this));
  }
  TextareaSurface.prototype = Object.create(Surface.prototype);
  TextareaSurface.prototype.constructor = TextareaSurface;
  TextareaSurface.prototype.elementType = 'textarea';
  TextareaSurface.prototype.elementClass = 'famous-surface';
  TextareaSurface.prototype.setPlaceholder = function setPlaceholder(str) {
    this._placeholder = str;
    this._contentDirty = true;
    return this;
  };
  TextareaSurface.prototype.focus = function focus() {
    if (this._currentTarget)
      this._currentTarget.focus();
    return this;
  };
  TextareaSurface.prototype.blur = function blur() {
    if (this._currentTarget)
      this._currentTarget.blur();
    return this;
  };
  TextareaSurface.prototype.setValue = function setValue(str) {
    this._value = str;
    this._contentDirty = true;
    return this;
  };
  TextareaSurface.prototype.getValue = function getValue() {
    if (this._currentTarget) {
      return this._currentTarget.value;
    } else {
      return this._value;
    }
  };
  TextareaSurface.prototype.setName = function setName(str) {
    this._name = str;
    this._contentDirty = true;
    return this;
  };
  TextareaSurface.prototype.getName = function getName() {
    return this._name;
  };
  TextareaSurface.prototype.setWrap = function setWrap(str) {
    this._wrap = str;
    this._contentDirty = true;
    return this;
  };
  TextareaSurface.prototype.setColumns = function setColumns(num) {
    this._cols = num;
    this._contentDirty = true;
    return this;
  };
  TextareaSurface.prototype.setRows = function setRows(num) {
    this._rows = num;
    this._contentDirty = true;
    return this;
  };
  TextareaSurface.prototype.deploy = function deploy(target) {
    if (this._placeholder !== '')
      target.placeholder = this._placeholder;
    if (this._value !== '')
      target.value = this._value;
    if (this._name !== '')
      target.name = this._name;
    if (this._wrap !== '')
      target.wrap = this._wrap;
    if (this._cols !== '')
      target.cols = this._cols;
    if (this._rows !== '')
      target.rows = this._rows;
  };
  module.exports = TextareaSurface;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/surfaces/VideoSurface", ["npm:famous@0.3.5/core/Surface"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var Surface = require("npm:famous@0.3.5/core/Surface");
  function VideoSurface(options) {
    Surface.apply(this, arguments);
    this._videoUrl = undefined;
    this.options = Object.create(VideoSurface.DEFAULT_OPTIONS);
    if (options)
      this.setOptions(options);
  }
  VideoSurface.prototype = Object.create(Surface.prototype);
  VideoSurface.prototype.constructor = VideoSurface;
  VideoSurface.DEFAULT_OPTIONS = {autoplay: false};
  VideoSurface.prototype.elementType = 'video';
  VideoSurface.prototype.elementClass = 'famous-surface';
  VideoSurface.prototype.setOptions = function setOptions(options) {
    if (options.size)
      this.setSize(options.size);
    if (options.classes)
      this.setClasses(options.classes);
    if (options.properties)
      this.setProperties(options.properties);
    if (options.autoplay)
      this.options.autoplay = options.autoplay;
    if (options.src) {
      this._videoUrl = options.src;
      this._contentDirty = true;
    }
  };
  VideoSurface.prototype.setContent = function setContent(videoUrl) {
    this._videoUrl = videoUrl;
    this._contentDirty = true;
  };
  VideoSurface.prototype.deploy = function deploy(target) {
    target.src = this._videoUrl;
    target.autoplay = this.options.autoplay;
  };
  VideoSurface.prototype.recall = function recall(target) {
    target.src = '';
  };
  module.exports = VideoSurface;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/transitions/CachedMap", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  function CachedMap(mappingFunction) {
    this._map = mappingFunction || null;
    this._cachedOutput = null;
    this._cachedInput = Number.NaN;
  }
  CachedMap.create = function create(mappingFunction) {
    var instance = new CachedMap(mappingFunction);
    return instance.get.bind(instance);
  };
  CachedMap.prototype.get = function get(input) {
    if (input !== this._cachedInput) {
      this._cachedInput = input;
      this._cachedOutput = this._map(input);
    }
    return this._cachedOutput;
  };
  module.exports = CachedMap;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/transitions/Easing", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var Easing = {
    inQuad: function(t) {
      return t * t;
    },
    outQuad: function(t) {
      return -(t -= 1) * t + 1;
    },
    inOutQuad: function(t) {
      if ((t /= 0.5) < 1)
        return 0.5 * t * t;
      return -0.5 * (--t * (t - 2) - 1);
    },
    inCubic: function(t) {
      return t * t * t;
    },
    outCubic: function(t) {
      return --t * t * t + 1;
    },
    inOutCubic: function(t) {
      if ((t /= 0.5) < 1)
        return 0.5 * t * t * t;
      return 0.5 * ((t -= 2) * t * t + 2);
    },
    inQuart: function(t) {
      return t * t * t * t;
    },
    outQuart: function(t) {
      return -(--t * t * t * t - 1);
    },
    inOutQuart: function(t) {
      if ((t /= 0.5) < 1)
        return 0.5 * t * t * t * t;
      return -0.5 * ((t -= 2) * t * t * t - 2);
    },
    inQuint: function(t) {
      return t * t * t * t * t;
    },
    outQuint: function(t) {
      return --t * t * t * t * t + 1;
    },
    inOutQuint: function(t) {
      if ((t /= 0.5) < 1)
        return 0.5 * t * t * t * t * t;
      return 0.5 * ((t -= 2) * t * t * t * t + 2);
    },
    inSine: function(t) {
      return -1 * Math.cos(t * (Math.PI / 2)) + 1;
    },
    outSine: function(t) {
      return Math.sin(t * (Math.PI / 2));
    },
    inOutSine: function(t) {
      return -0.5 * (Math.cos(Math.PI * t) - 1);
    },
    inExpo: function(t) {
      return t === 0 ? 0 : Math.pow(2, 10 * (t - 1));
    },
    outExpo: function(t) {
      return t === 1 ? 1 : -Math.pow(2, -10 * t) + 1;
    },
    inOutExpo: function(t) {
      if (t === 0)
        return 0;
      if (t === 1)
        return 1;
      if ((t /= 0.5) < 1)
        return 0.5 * Math.pow(2, 10 * (t - 1));
      return 0.5 * (-Math.pow(2, -10 * --t) + 2);
    },
    inCirc: function(t) {
      return -(Math.sqrt(1 - t * t) - 1);
    },
    outCirc: function(t) {
      return Math.sqrt(1 - --t * t);
    },
    inOutCirc: function(t) {
      if ((t /= 0.5) < 1)
        return -0.5 * (Math.sqrt(1 - t * t) - 1);
      return 0.5 * (Math.sqrt(1 - (t -= 2) * t) + 1);
    },
    inElastic: function(t) {
      var s = 1.70158;
      var p = 0;
      var a = 1;
      if (t === 0)
        return 0;
      if (t === 1)
        return 1;
      if (!p)
        p = 0.3;
      s = p / (2 * Math.PI) * Math.asin(1 / a);
      return -(a * Math.pow(2, 10 * (t -= 1)) * Math.sin((t - s) * (2 * Math.PI) / p));
    },
    outElastic: function(t) {
      var s = 1.70158;
      var p = 0;
      var a = 1;
      if (t === 0)
        return 0;
      if (t === 1)
        return 1;
      if (!p)
        p = 0.3;
      s = p / (2 * Math.PI) * Math.asin(1 / a);
      return a * Math.pow(2, -10 * t) * Math.sin((t - s) * (2 * Math.PI) / p) + 1;
    },
    inOutElastic: function(t) {
      var s = 1.70158;
      var p = 0;
      var a = 1;
      if (t === 0)
        return 0;
      if ((t /= 0.5) === 2)
        return 1;
      if (!p)
        p = 0.3 * 1.5;
      s = p / (2 * Math.PI) * Math.asin(1 / a);
      if (t < 1)
        return -0.5 * (a * Math.pow(2, 10 * (t -= 1)) * Math.sin((t - s) * (2 * Math.PI) / p));
      return a * Math.pow(2, -10 * (t -= 1)) * Math.sin((t - s) * (2 * Math.PI) / p) * 0.5 + 1;
    },
    inBack: function(t, s) {
      if (s === undefined)
        s = 1.70158;
      return t * t * ((s + 1) * t - s);
    },
    outBack: function(t, s) {
      if (s === undefined)
        s = 1.70158;
      return --t * t * ((s + 1) * t + s) + 1;
    },
    inOutBack: function(t, s) {
      if (s === undefined)
        s = 1.70158;
      if ((t /= 0.5) < 1)
        return 0.5 * (t * t * (((s *= 1.525) + 1) * t - s));
      return 0.5 * ((t -= 2) * t * (((s *= 1.525) + 1) * t + s) + 2);
    },
    inBounce: function(t) {
      return 1 - Easing.outBounce(1 - t);
    },
    outBounce: function(t) {
      if (t < 1 / 2.75) {
        return 7.5625 * t * t;
      } else if (t < 2 / 2.75) {
        return 7.5625 * (t -= 1.5 / 2.75) * t + 0.75;
      } else if (t < 2.5 / 2.75) {
        return 7.5625 * (t -= 2.25 / 2.75) * t + 0.9375;
      } else {
        return 7.5625 * (t -= 2.625 / 2.75) * t + 0.984375;
      }
    },
    inOutBounce: function(t) {
      if (t < 0.5)
        return Easing.inBounce(t * 2) * 0.5;
      return Easing.outBounce(t * 2 - 1) * 0.5 + 0.5;
    }
  };
  module.exports = Easing;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/transitions/SnapTransition", ["npm:famous@0.3.5/physics/PhysicsEngine", "npm:famous@0.3.5/physics/bodies/Particle", "npm:famous@0.3.5/physics/constraints/Snap", "npm:famous@0.3.5/math/Vector"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var PE = require("npm:famous@0.3.5/physics/PhysicsEngine");
  var Particle = require("npm:famous@0.3.5/physics/bodies/Particle");
  var Spring = require("npm:famous@0.3.5/physics/constraints/Snap");
  var Vector = require("npm:famous@0.3.5/math/Vector");
  function SnapTransition(state) {
    state = state || 0;
    this.endState = new Vector(state);
    this.initState = new Vector();
    this._dimensions = 1;
    this._restTolerance = 1e-10;
    this._absRestTolerance = this._restTolerance;
    this._callback = undefined;
    this.PE = new PE();
    this.particle = new Particle();
    this.spring = new Spring({anchor: this.endState});
    this.PE.addBody(this.particle);
    this.PE.attach(this.spring, this.particle);
  }
  SnapTransition.SUPPORTS_MULTIPLE = 3;
  SnapTransition.DEFAULT_OPTIONS = {
    period: 100,
    dampingRatio: 0.2,
    velocity: 0
  };
  function _getEnergy() {
    return this.particle.getEnergy() + this.spring.getEnergy([this.particle]);
  }
  function _setAbsoluteRestTolerance() {
    var distance = this.endState.sub(this.initState).normSquared();
    this._absRestTolerance = distance === 0 ? this._restTolerance : this._restTolerance * distance;
  }
  function _setTarget(target) {
    this.endState.set(target);
    _setAbsoluteRestTolerance.call(this);
  }
  function _wake() {
    this.PE.wake();
  }
  function _sleep() {
    this.PE.sleep();
  }
  function _setParticlePosition(p) {
    this.particle.position.set(p);
  }
  function _setParticleVelocity(v) {
    this.particle.velocity.set(v);
  }
  function _getParticlePosition() {
    return this._dimensions === 0 ? this.particle.getPosition1D() : this.particle.getPosition();
  }
  function _getParticleVelocity() {
    return this._dimensions === 0 ? this.particle.getVelocity1D() : this.particle.getVelocity();
  }
  function _setCallback(callback) {
    this._callback = callback;
  }
  function _setupDefinition(definition) {
    var defaults = SnapTransition.DEFAULT_OPTIONS;
    if (definition.period === undefined)
      definition.period = defaults.period;
    if (definition.dampingRatio === undefined)
      definition.dampingRatio = defaults.dampingRatio;
    if (definition.velocity === undefined)
      definition.velocity = defaults.velocity;
    this.spring.setOptions({
      period: definition.period,
      dampingRatio: definition.dampingRatio
    });
    _setParticleVelocity.call(this, definition.velocity);
  }
  function _update() {
    if (this.PE.isSleeping()) {
      if (this._callback) {
        var cb = this._callback;
        this._callback = undefined;
        cb();
      }
      return ;
    }
    if (_getEnergy.call(this) < this._absRestTolerance) {
      _setParticlePosition.call(this, this.endState);
      _setParticleVelocity.call(this, [0, 0, 0]);
      _sleep.call(this);
    }
  }
  SnapTransition.prototype.reset = function reset(state, velocity) {
    this._dimensions = state instanceof Array ? state.length : 0;
    this.initState.set(state);
    _setParticlePosition.call(this, state);
    _setTarget.call(this, state);
    if (velocity)
      _setParticleVelocity.call(this, velocity);
    _setCallback.call(this, undefined);
  };
  SnapTransition.prototype.getVelocity = function getVelocity() {
    return _getParticleVelocity.call(this);
  };
  SnapTransition.prototype.setVelocity = function setVelocity(velocity) {
    this.call(this, _setParticleVelocity(velocity));
  };
  SnapTransition.prototype.isActive = function isActive() {
    return !this.PE.isSleeping();
  };
  SnapTransition.prototype.halt = function halt() {
    this.set(this.get());
  };
  SnapTransition.prototype.get = function get() {
    _update.call(this);
    return _getParticlePosition.call(this);
  };
  SnapTransition.prototype.set = function set(state, definition, callback) {
    if (!definition) {
      this.reset(state);
      if (callback)
        callback();
      return ;
    }
    this._dimensions = state instanceof Array ? state.length : 0;
    _wake.call(this);
    _setupDefinition.call(this, definition);
    _setTarget.call(this, state);
    _setCallback.call(this, callback);
  };
  module.exports = SnapTransition;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/transitions/SpringTransition", ["npm:famous@0.3.5/physics/PhysicsEngine", "npm:famous@0.3.5/physics/bodies/Particle", "npm:famous@0.3.5/physics/forces/Spring", "npm:famous@0.3.5/math/Vector"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var PE = require("npm:famous@0.3.5/physics/PhysicsEngine");
  var Particle = require("npm:famous@0.3.5/physics/bodies/Particle");
  var Spring = require("npm:famous@0.3.5/physics/forces/Spring");
  var Vector = require("npm:famous@0.3.5/math/Vector");
  function SpringTransition(state) {
    state = state || 0;
    this.endState = new Vector(state);
    this.initState = new Vector();
    this._dimensions = undefined;
    this._restTolerance = 1e-10;
    this._absRestTolerance = this._restTolerance;
    this._callback = undefined;
    this.PE = new PE();
    this.spring = new Spring({anchor: this.endState});
    this.particle = new Particle();
    this.PE.addBody(this.particle);
    this.PE.attach(this.spring, this.particle);
  }
  SpringTransition.SUPPORTS_MULTIPLE = 3;
  SpringTransition.DEFAULT_OPTIONS = {
    period: 300,
    dampingRatio: 0.5,
    velocity: 0
  };
  function _getEnergy() {
    return this.particle.getEnergy() + this.spring.getEnergy([this.particle]);
  }
  function _setParticlePosition(p) {
    this.particle.setPosition(p);
  }
  function _setParticleVelocity(v) {
    this.particle.setVelocity(v);
  }
  function _getParticlePosition() {
    return this._dimensions === 0 ? this.particle.getPosition1D() : this.particle.getPosition();
  }
  function _getParticleVelocity() {
    return this._dimensions === 0 ? this.particle.getVelocity1D() : this.particle.getVelocity();
  }
  function _setCallback(callback) {
    this._callback = callback;
  }
  function _wake() {
    this.PE.wake();
  }
  function _sleep() {
    this.PE.sleep();
  }
  function _update() {
    if (this.PE.isSleeping()) {
      if (this._callback) {
        var cb = this._callback;
        this._callback = undefined;
        cb();
      }
      return ;
    }
    if (_getEnergy.call(this) < this._absRestTolerance) {
      _setParticlePosition.call(this, this.endState);
      _setParticleVelocity.call(this, [0, 0, 0]);
      _sleep.call(this);
    }
  }
  function _setupDefinition(definition) {
    var defaults = SpringTransition.DEFAULT_OPTIONS;
    if (definition.period === undefined)
      definition.period = defaults.period;
    if (definition.dampingRatio === undefined)
      definition.dampingRatio = defaults.dampingRatio;
    if (definition.velocity === undefined)
      definition.velocity = defaults.velocity;
    if (definition.period < 150) {
      definition.period = 150;
      console.warn('The period of a SpringTransition is capped at 150 ms. Use a SnapTransition for faster transitions');
    }
    this.spring.setOptions({
      period: definition.period,
      dampingRatio: definition.dampingRatio
    });
    _setParticleVelocity.call(this, definition.velocity);
  }
  function _setAbsoluteRestTolerance() {
    var distance = this.endState.sub(this.initState).normSquared();
    this._absRestTolerance = distance === 0 ? this._restTolerance : this._restTolerance * distance;
  }
  function _setTarget(target) {
    this.endState.set(target);
    _setAbsoluteRestTolerance.call(this);
  }
  SpringTransition.prototype.reset = function reset(pos, vel) {
    this._dimensions = pos instanceof Array ? pos.length : 0;
    this.initState.set(pos);
    _setParticlePosition.call(this, pos);
    _setTarget.call(this, pos);
    if (vel)
      _setParticleVelocity.call(this, vel);
    _setCallback.call(this, undefined);
  };
  SpringTransition.prototype.getVelocity = function getVelocity() {
    return _getParticleVelocity.call(this);
  };
  SpringTransition.prototype.setVelocity = function setVelocity(v) {
    this.call(this, _setParticleVelocity(v));
  };
  SpringTransition.prototype.isActive = function isActive() {
    return !this.PE.isSleeping();
  };
  SpringTransition.prototype.halt = function halt() {
    this.set(this.get());
  };
  SpringTransition.prototype.get = function get() {
    _update.call(this);
    return _getParticlePosition.call(this);
  };
  SpringTransition.prototype.set = function set(endState, definition, callback) {
    if (!definition) {
      this.reset(endState);
      if (callback)
        callback();
      return ;
    }
    this._dimensions = endState instanceof Array ? endState.length : 0;
    _wake.call(this);
    _setupDefinition.call(this, definition);
    _setTarget.call(this, endState);
    _setCallback.call(this, callback);
  };
  module.exports = SpringTransition;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/transitions/WallTransition", ["npm:famous@0.3.5/physics/PhysicsEngine", "npm:famous@0.3.5/physics/bodies/Particle", "npm:famous@0.3.5/physics/forces/Spring", "npm:famous@0.3.5/physics/constraints/Wall", "npm:famous@0.3.5/math/Vector"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var PE = require("npm:famous@0.3.5/physics/PhysicsEngine");
  var Particle = require("npm:famous@0.3.5/physics/bodies/Particle");
  var Spring = require("npm:famous@0.3.5/physics/forces/Spring");
  var Wall = require("npm:famous@0.3.5/physics/constraints/Wall");
  var Vector = require("npm:famous@0.3.5/math/Vector");
  function WallTransition(state) {
    state = state || 0;
    this.endState = new Vector(state);
    this.initState = new Vector();
    this.spring = new Spring({anchor: this.endState});
    this.wall = new Wall();
    this._restTolerance = 1e-10;
    this._dimensions = 1;
    this._absRestTolerance = this._restTolerance;
    this._callback = undefined;
    this.PE = new PE();
    this.particle = new Particle();
    this.PE.addBody(this.particle);
    this.PE.attach([this.wall, this.spring], this.particle);
  }
  WallTransition.SUPPORTS_MULTIPLE = 3;
  WallTransition.DEFAULT_OPTIONS = {
    period: 300,
    dampingRatio: 0.5,
    velocity: 0,
    restitution: 0.5
  };
  function _getEnergy() {
    return this.particle.getEnergy() + this.spring.getEnergy([this.particle]);
  }
  function _setAbsoluteRestTolerance() {
    var distance = this.endState.sub(this.initState).normSquared();
    this._absRestTolerance = distance === 0 ? this._restTolerance : this._restTolerance * distance;
  }
  function _wake() {
    this.PE.wake();
  }
  function _sleep() {
    this.PE.sleep();
  }
  function _setTarget(target) {
    this.endState.set(target);
    var dist = this.endState.sub(this.initState).norm();
    this.wall.setOptions({
      distance: this.endState.norm(),
      normal: dist === 0 ? this.particle.velocity.normalize(-1) : this.endState.sub(this.initState).normalize(-1)
    });
    _setAbsoluteRestTolerance.call(this);
  }
  function _setParticlePosition(p) {
    this.particle.position.set(p);
  }
  function _setParticleVelocity(v) {
    this.particle.velocity.set(v);
  }
  function _getParticlePosition() {
    return this._dimensions === 0 ? this.particle.getPosition1D() : this.particle.getPosition();
  }
  function _getParticleVelocity() {
    return this._dimensions === 0 ? this.particle.getVelocity1D() : this.particle.getVelocity();
  }
  function _setCallback(callback) {
    this._callback = callback;
  }
  function _update() {
    if (this.PE.isSleeping()) {
      if (this._callback) {
        var cb = this._callback;
        this._callback = undefined;
        cb();
      }
      return ;
    }
    var energy = _getEnergy.call(this);
    if (energy < this._absRestTolerance) {
      _sleep.call(this);
      _setParticlePosition.call(this, this.endState);
      _setParticleVelocity.call(this, [0, 0, 0]);
    }
  }
  function _setupDefinition(def) {
    var defaults = WallTransition.DEFAULT_OPTIONS;
    if (def.period === undefined)
      def.period = defaults.period;
    if (def.dampingRatio === undefined)
      def.dampingRatio = defaults.dampingRatio;
    if (def.velocity === undefined)
      def.velocity = defaults.velocity;
    if (def.restitution === undefined)
      def.restitution = defaults.restitution;
    if (def.drift === undefined)
      def.drift = Wall.DEFAULT_OPTIONS.drift;
    if (def.slop === undefined)
      def.slop = Wall.DEFAULT_OPTIONS.slop;
    this.spring.setOptions({
      period: def.period,
      dampingRatio: def.dampingRatio
    });
    this.wall.setOptions({
      restitution: def.restitution,
      drift: def.drift,
      slop: def.slop
    });
    _setParticleVelocity.call(this, def.velocity);
  }
  WallTransition.prototype.reset = function reset(state, velocity) {
    this._dimensions = state instanceof Array ? state.length : 0;
    this.initState.set(state);
    _setParticlePosition.call(this, state);
    if (velocity)
      _setParticleVelocity.call(this, velocity);
    _setTarget.call(this, state);
    _setCallback.call(this, undefined);
  };
  WallTransition.prototype.getVelocity = function getVelocity() {
    return _getParticleVelocity.call(this);
  };
  WallTransition.prototype.setVelocity = function setVelocity(velocity) {
    this.call(this, _setParticleVelocity(velocity));
  };
  WallTransition.prototype.isActive = function isActive() {
    return !this.PE.isSleeping();
  };
  WallTransition.prototype.halt = function halt() {
    this.set(this.get());
  };
  WallTransition.prototype.get = function get() {
    _update.call(this);
    return _getParticlePosition.call(this);
  };
  WallTransition.prototype.set = function set(state, definition, callback) {
    if (!definition) {
      this.reset(state);
      if (callback)
        callback();
      return ;
    }
    this._dimensions = state instanceof Array ? state.length : 0;
    _wake.call(this);
    _setupDefinition.call(this, definition);
    _setTarget.call(this, state);
    _setCallback.call(this, callback);
  };
  module.exports = WallTransition;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/utilities/KeyCodes", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var KeyCodes = {
    0: 48,
    1: 49,
    2: 50,
    3: 51,
    4: 52,
    5: 53,
    6: 54,
    7: 55,
    8: 56,
    9: 57,
    a: 97,
    b: 98,
    c: 99,
    d: 100,
    e: 101,
    f: 102,
    g: 103,
    h: 104,
    i: 105,
    j: 106,
    k: 107,
    l: 108,
    m: 109,
    n: 110,
    o: 111,
    p: 112,
    q: 113,
    r: 114,
    s: 115,
    t: 116,
    u: 117,
    v: 118,
    w: 119,
    x: 120,
    y: 121,
    z: 122,
    A: 65,
    B: 66,
    C: 67,
    D: 68,
    E: 69,
    F: 70,
    G: 71,
    H: 72,
    I: 73,
    J: 74,
    K: 75,
    L: 76,
    M: 77,
    N: 78,
    O: 79,
    P: 80,
    Q: 81,
    R: 82,
    S: 83,
    T: 84,
    U: 85,
    V: 86,
    W: 87,
    X: 88,
    Y: 89,
    Z: 90,
    ENTER: 13,
    LEFT_ARROW: 37,
    RIGHT_ARROW: 39,
    UP_ARROW: 38,
    DOWN_ARROW: 40,
    SPACE: 32,
    SHIFT: 16,
    TAB: 9
  };
  module.exports = KeyCodes;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/utilities/Timer", ["npm:famous@0.3.5/core/Engine"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var FamousEngine = require("npm:famous@0.3.5/core/Engine");
  var _event = 'prerender';
  var getTime = window.performance && window.performance.now ? function() {
    return window.performance.now();
  } : function() {
    return Date.now();
  };
  function addTimerFunction(fn) {
    FamousEngine.on(_event, fn);
    return fn;
  }
  function setTimeout(fn, duration) {
    var t = getTime();
    var callback = function() {
      var t2 = getTime();
      if (t2 - t >= duration) {
        fn.apply(this, arguments);
        FamousEngine.removeListener(_event, callback);
      }
    };
    return addTimerFunction(callback);
  }
  function setInterval(fn, duration) {
    var t = getTime();
    var callback = function() {
      var t2 = getTime();
      if (t2 - t >= duration) {
        fn.apply(this, arguments);
        t = getTime();
      }
    };
    return addTimerFunction(callback);
  }
  function after(fn, numTicks) {
    if (numTicks === undefined)
      return undefined;
    var callback = function() {
      numTicks--;
      if (numTicks <= 0) {
        fn.apply(this, arguments);
        clear(callback);
      }
    };
    return addTimerFunction(callback);
  }
  function every(fn, numTicks) {
    numTicks = numTicks || 1;
    var initial = numTicks;
    var callback = function() {
      numTicks--;
      if (numTicks <= 0) {
        fn.apply(this, arguments);
        numTicks = initial;
      }
    };
    return addTimerFunction(callback);
  }
  function clear(fn) {
    FamousEngine.removeListener(_event, fn);
  }
  function debounce(func, wait) {
    var timeout;
    var ctx;
    var timestamp;
    var result;
    var args;
    return function() {
      ctx = this;
      args = arguments;
      timestamp = getTime();
      var fn = function() {
        var last = getTime - timestamp;
        if (last < wait) {
          timeout = setTimeout(fn, wait - last);
        } else {
          timeout = null;
          result = func.apply(ctx, args);
        }
      };
      clear(timeout);
      timeout = setTimeout(fn, wait);
      return result;
    };
  }
  module.exports = {
    setTimeout: setTimeout,
    setInterval: setInterval,
    debounce: debounce,
    after: after,
    every: every,
    clear: clear
  };
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/views/ContextualView", ["npm:famous@0.3.5/core/Entity", "npm:famous@0.3.5/core/Transform", "npm:famous@0.3.5/core/EventHandler", "npm:famous@0.3.5/core/OptionsManager"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var Entity = require("npm:famous@0.3.5/core/Entity");
  var Transform = require("npm:famous@0.3.5/core/Transform");
  var EventHandler = require("npm:famous@0.3.5/core/EventHandler");
  var OptionsManager = require("npm:famous@0.3.5/core/OptionsManager");
  function ContextualView(options) {
    this.options = Object.create(this.constructor.DEFAULT_OPTIONS || ContextualView.DEFAULT_OPTIONS);
    this._optionsManager = new OptionsManager(this.options);
    if (options)
      this.setOptions(options);
    this._eventInput = new EventHandler();
    this._eventOutput = new EventHandler();
    EventHandler.setInputHandler(this, this._eventInput);
    EventHandler.setOutputHandler(this, this._eventOutput);
    this._id = Entity.register(this);
  }
  ContextualView.DEFAULT_OPTIONS = {};
  ContextualView.prototype.setOptions = function setOptions(options) {
    return this._optionsManager.setOptions(options);
  };
  ContextualView.prototype.getOptions = function getOptions(key) {
    return this._optionsManager.getOptions(key);
  };
  ContextualView.prototype.render = function render() {
    return this._id;
  };
  ContextualView.prototype.commit = function commit(context) {};
  module.exports = ContextualView;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/views/SequentialLayout", ["npm:famous@0.3.5/core/OptionsManager", "npm:famous@0.3.5/core/Entity", "npm:famous@0.3.5/core/Transform", "npm:famous@0.3.5/core/ViewSequence", "npm:famous@0.3.5/utilities/Utility"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var OptionsManager = require("npm:famous@0.3.5/core/OptionsManager");
  var Entity = require("npm:famous@0.3.5/core/Entity");
  var Transform = require("npm:famous@0.3.5/core/Transform");
  var ViewSequence = require("npm:famous@0.3.5/core/ViewSequence");
  var Utility = require("npm:famous@0.3.5/utilities/Utility");
  function SequentialLayout(options) {
    this._items = null;
    this._size = null;
    this._outputFunction = SequentialLayout.DEFAULT_OUTPUT_FUNCTION;
    this.options = Utility.clone(this.constructor.DEFAULT_OPTIONS || SequentialLayout.DEFAULT_OPTIONS);
    this.optionsManager = new OptionsManager(this.options);
    this.id = Entity.register(this);
    this.cachedSize = [undefined, undefined];
    if (options)
      this.setOptions(options);
  }
  SequentialLayout.DEFAULT_OPTIONS = {
    direction: Utility.Direction.Y,
    itemSpacing: 0
  };
  SequentialLayout.DEFAULT_OUTPUT_FUNCTION = function DEFAULT_OUTPUT_FUNCTION(input, offset, index) {
    var transform = this.options.direction === Utility.Direction.X ? Transform.translate(offset, 0) : Transform.translate(0, offset);
    return {
      size: this.cachedSize,
      transform: transform,
      target: input.render()
    };
  };
  SequentialLayout.prototype.getSize = function getSize() {
    if (!this._size)
      this.render();
    return this._size;
  };
  SequentialLayout.prototype.sequenceFrom = function sequenceFrom(items) {
    if (items instanceof Array)
      items = new ViewSequence(items);
    this._items = items;
    return this;
  };
  SequentialLayout.prototype.setOptions = function setOptions(options) {
    this.optionsManager.setOptions.apply(this.optionsManager, arguments);
    return this;
  };
  SequentialLayout.prototype.setOutputFunction = function setOutputFunction(outputFunction) {
    this._outputFunction = outputFunction;
    return this;
  };
  SequentialLayout.prototype.render = function render() {
    return this.id;
  };
  SequentialLayout.prototype.commit = function commit(parentSpec) {
    var length = 0;
    var secondaryDirection = this.options.direction ^ 1;
    var currentNode = this._items;
    var item = null;
    var itemSize = [];
    var output = {};
    var result = [];
    var i = 0;
    this._size = [0, 0];
    this.cachedSize = parentSpec.size;
    while (currentNode) {
      item = currentNode.get();
      if (!item)
        break;
      if (item.getSize)
        itemSize = item.getSize();
      output = this._outputFunction.call(this, item, length, i++);
      result.push(output);
      if (itemSize) {
        if (itemSize[this.options.direction])
          length += itemSize[this.options.direction];
        if (itemSize[secondaryDirection] > this._size[secondaryDirection])
          this._size[secondaryDirection] = itemSize[secondaryDirection];
        if (itemSize[secondaryDirection] === 0)
          this._size[secondaryDirection] = undefined;
      }
      currentNode = currentNode.getNext();
      if (this.options.itemSpacing && currentNode)
        length += this.options.itemSpacing;
    }
    this._size[this.options.direction] = length;
    return {
      transform: parentSpec.transform,
      origin: parentSpec.origin,
      opacity: parentSpec.opacity,
      size: this.getSize(),
      target: result
    };
  };
  module.exports = SequentialLayout;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/views/DrawerLayout", ["npm:famous@0.3.5/core/RenderNode", "npm:famous@0.3.5/core/Transform", "npm:famous@0.3.5/core/OptionsManager", "npm:famous@0.3.5/transitions/Transitionable", "npm:famous@0.3.5/core/EventHandler"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var RenderNode = require("npm:famous@0.3.5/core/RenderNode");
  var Transform = require("npm:famous@0.3.5/core/Transform");
  var OptionsManager = require("npm:famous@0.3.5/core/OptionsManager");
  var Transitionable = require("npm:famous@0.3.5/transitions/Transitionable");
  var EventHandler = require("npm:famous@0.3.5/core/EventHandler");
  function DrawerLayout(options) {
    this.options = Object.create(DrawerLayout.DEFAULT_OPTIONS);
    this._optionsManager = new OptionsManager(this.options);
    if (options)
      this.setOptions(options);
    this._position = new Transitionable(0);
    this._direction = _getDirectionFromSide(this.options.side);
    this._orientation = _getOrientationFromSide(this.options.side);
    this._isOpen = false;
    this._cachedLength = 0;
    this.drawer = new RenderNode();
    this.content = new RenderNode();
    this._eventInput = new EventHandler();
    this._eventOutput = new EventHandler();
    EventHandler.setInputHandler(this, this._eventInput);
    EventHandler.setOutputHandler(this, this._eventOutput);
    this._eventInput.on('update', _handleUpdate.bind(this));
    this._eventInput.on('end', _handleEnd.bind(this));
  }
  var DIRECTION_X = 0;
  var DIRECTION_Y = 1;
  DrawerLayout.SIDES = {
    LEFT: 0,
    TOP: 1,
    RIGHT: 2,
    BOTTOM: 3
  };
  DrawerLayout.DEFAULT_OPTIONS = {
    side: DrawerLayout.SIDES.LEFT,
    drawerLength: 0,
    velocityThreshold: 0,
    positionThreshold: 0,
    transition: true
  };
  function _getDirectionFromSide(side) {
    var SIDES = DrawerLayout.SIDES;
    return side === SIDES.LEFT || side === SIDES.RIGHT ? DIRECTION_X : DIRECTION_Y;
  }
  function _getOrientationFromSide(side) {
    var SIDES = DrawerLayout.SIDES;
    return side === SIDES.LEFT || side === SIDES.TOP ? 1 : -1;
  }
  function _resolveNodeSize(node) {
    var options = this.options;
    var size;
    if (options.drawerLength)
      size = options.drawerLength;
    else {
      var nodeSize = node.getSize();
      size = nodeSize ? nodeSize[this._direction] : options.drawerLength;
    }
    return this._orientation * size;
  }
  function _handleUpdate(data) {
    var newPosition = this.getPosition() + data.delta;
    var MIN_LENGTH;
    var MAX_LENGTH;
    this._cachedLength = _resolveNodeSize.call(this, this.drawer);
    if (this._orientation === 1) {
      MIN_LENGTH = 0;
      MAX_LENGTH = this._cachedLength;
    } else {
      MIN_LENGTH = this._cachedLength;
      MAX_LENGTH = 0;
    }
    if (newPosition > MAX_LENGTH)
      newPosition = MAX_LENGTH;
    else if (newPosition < MIN_LENGTH)
      newPosition = MIN_LENGTH;
    this.setPosition(newPosition);
  }
  function _handleEnd(data) {
    var velocity = data.velocity;
    var position = this._orientation * this.getPosition();
    var options = this.options;
    var MAX_LENGTH = this._orientation * this._cachedLength;
    var positionThreshold = options.positionThreshold || MAX_LENGTH / 2;
    var velocityThreshold = options.velocityThreshold;
    if (options.transition instanceof Object)
      options.transition.velocity = data.velocity;
    if (position === 0) {
      this._isOpen = false;
      return ;
    }
    if (position === MAX_LENGTH) {
      this._isOpen = true;
      return ;
    }
    var shouldToggle = Math.abs(velocity) > velocityThreshold || !this._isOpen && position > positionThreshold || this._isOpen && position < positionThreshold;
    if (shouldToggle)
      this.toggle();
    else
      this.reset();
  }
  DrawerLayout.prototype.setOptions = function setOptions(options) {
    this._optionsManager.setOptions(options);
    if (options.side !== undefined) {
      this._direction = _getDirectionFromSide(options.side);
      this._orientation = _getOrientationFromSide(options.side);
    }
  };
  DrawerLayout.prototype.open = function open(transition, callback) {
    if (transition instanceof Function)
      callback = transition;
    if (transition === undefined)
      transition = this.options.transition;
    this._cachedLength = _resolveNodeSize.call(this, this.drawer);
    this.setPosition(this._cachedLength, transition, callback);
    if (!this._isOpen) {
      this._isOpen = true;
      this._eventOutput.emit('open');
    }
  };
  DrawerLayout.prototype.close = function close(transition, callback) {
    if (transition instanceof Function)
      callback = transition;
    if (transition === undefined)
      transition = this.options.transition;
    this.setPosition(0, transition, callback);
    if (this._isOpen) {
      this._isOpen = false;
      this._eventOutput.emit('close');
    }
  };
  DrawerLayout.prototype.setPosition = function setPosition(position, transition, callback) {
    if (this._position.isActive())
      this._position.halt();
    this._position.set(position, transition, callback);
  };
  DrawerLayout.prototype.getPosition = function getPosition() {
    return this._position.get();
  };
  DrawerLayout.prototype.setProgress = function setProgress(progress, transition, callback) {
    return this._position.set(progress * this._cachedLength, transition, callback);
  };
  DrawerLayout.prototype.getProgress = function getProgress() {
    return this._position.get() / this._cachedLength;
  };
  DrawerLayout.prototype.toggle = function toggle(transition) {
    if (this._isOpen)
      this.close(transition);
    else
      this.open(transition);
  };
  DrawerLayout.prototype.reset = function reset(transition) {
    if (this._isOpen)
      this.open(transition);
    else
      this.close(transition);
  };
  DrawerLayout.prototype.isOpen = function isOpen(transition) {
    return this._isOpen;
  };
  DrawerLayout.prototype.render = function render() {
    var position = this.getPosition();
    if (!this._isOpen && (position < 0 && this._orientation === 1) || position > 0 && this._orientation === -1) {
      position = 0;
      this.setPosition(position);
    }
    var contentTransform = this._direction === DIRECTION_X ? Transform.translate(position, 0, 0) : Transform.translate(0, position, 0);
    return [{
      transform: Transform.behind,
      target: this.drawer.render()
    }, {
      transform: contentTransform,
      target: this.content.render()
    }];
  };
  module.exports = DrawerLayout;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/views/RenderController", ["npm:famous@0.3.5/core/Modifier", "npm:famous@0.3.5/core/RenderNode", "npm:famous@0.3.5/core/Transform", "npm:famous@0.3.5/transitions/Transitionable", "npm:famous@0.3.5/core/View"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var Modifier = require("npm:famous@0.3.5/core/Modifier");
  var RenderNode = require("npm:famous@0.3.5/core/RenderNode");
  var Transform = require("npm:famous@0.3.5/core/Transform");
  var Transitionable = require("npm:famous@0.3.5/transitions/Transitionable");
  var View = require("npm:famous@0.3.5/core/View");
  function RenderController(options) {
    View.apply(this, arguments);
    this._showing = -1;
    this._outgoingRenderables = [];
    this._nextRenderable = null;
    this._renderables = [];
    this._nodes = [];
    this._modifiers = [];
    this._states = [];
    this.inTransformMap = RenderController.DefaultMap.transform;
    this.inOpacityMap = RenderController.DefaultMap.opacity;
    this.inOriginMap = RenderController.DefaultMap.origin;
    this.inAlignMap = RenderController.DefaultMap.align;
    this.outTransformMap = RenderController.DefaultMap.transform;
    this.outOpacityMap = RenderController.DefaultMap.opacity;
    this.outOriginMap = RenderController.DefaultMap.origin;
    this.outAlignMap = RenderController.DefaultMap.align;
    this._output = [];
  }
  RenderController.prototype = Object.create(View.prototype);
  RenderController.prototype.constructor = RenderController;
  RenderController.DEFAULT_OPTIONS = {
    inTransition: true,
    outTransition: true,
    overlap: true
  };
  RenderController.DefaultMap = {
    transform: function() {
      return Transform.identity;
    },
    opacity: function(progress) {
      return progress;
    },
    origin: null,
    align: null
  };
  function _mappedState(map, state) {
    return map(state.get());
  }
  RenderController.prototype.inTransformFrom = function inTransformFrom(transform) {
    if (transform instanceof Function)
      this.inTransformMap = transform;
    else if (transform && transform.get)
      this.inTransformMap = transform.get.bind(transform);
    else
      throw new Error('inTransformFrom takes only function or getter object');
    return this;
  };
  RenderController.prototype.inOpacityFrom = function inOpacityFrom(opacity) {
    if (opacity instanceof Function)
      this.inOpacityMap = opacity;
    else if (opacity && opacity.get)
      this.inOpacityMap = opacity.get.bind(opacity);
    else
      throw new Error('inOpacityFrom takes only function or getter object');
    return this;
  };
  RenderController.prototype.inOriginFrom = function inOriginFrom(origin) {
    if (origin instanceof Function)
      this.inOriginMap = origin;
    else if (origin && origin.get)
      this.inOriginMap = origin.get.bind(origin);
    else
      throw new Error('inOriginFrom takes only function or getter object');
    return this;
  };
  RenderController.prototype.inAlignFrom = function inAlignFrom(align) {
    if (align instanceof Function)
      this.inAlignMap = align;
    else if (align && align.get)
      this.inAlignMap = align.get.bind(align);
    else
      throw new Error('inAlignFrom takes only function or getter object');
    return this;
  };
  RenderController.prototype.outTransformFrom = function outTransformFrom(transform) {
    if (transform instanceof Function)
      this.outTransformMap = transform;
    else if (transform && transform.get)
      this.outTransformMap = transform.get.bind(transform);
    else
      throw new Error('outTransformFrom takes only function or getter object');
    return this;
  };
  RenderController.prototype.outOpacityFrom = function outOpacityFrom(opacity) {
    if (opacity instanceof Function)
      this.outOpacityMap = opacity;
    else if (opacity && opacity.get)
      this.outOpacityMap = opacity.get.bind(opacity);
    else
      throw new Error('outOpacityFrom takes only function or getter object');
    return this;
  };
  RenderController.prototype.outOriginFrom = function outOriginFrom(origin) {
    if (origin instanceof Function)
      this.outOriginMap = origin;
    else if (origin && origin.get)
      this.outOriginMap = origin.get.bind(origin);
    else
      throw new Error('outOriginFrom takes only function or getter object');
    return this;
  };
  RenderController.prototype.outAlignFrom = function outAlignFrom(align) {
    if (align instanceof Function)
      this.outAlignMap = align;
    else if (align && align.get)
      this.outAlignMap = align.get.bind(align);
    else
      throw new Error('outAlignFrom takes only function or getter object');
    return this;
  };
  RenderController.prototype.show = function show(renderable, transition, callback) {
    if (!renderable) {
      return this.hide(callback);
    }
    if (transition instanceof Function) {
      callback = transition;
      transition = null;
    }
    if (this._showing >= 0) {
      if (this.options.overlap)
        this.hide();
      else {
        if (this._nextRenderable) {
          this._nextRenderable = renderable;
        } else {
          this._nextRenderable = renderable;
          this.hide(function() {
            if (this._nextRenderable === renderable)
              this.show(this._nextRenderable, callback);
            this._nextRenderable = null;
          });
        }
        return undefined;
      }
    }
    var state = null;
    var renderableIndex = this._renderables.indexOf(renderable);
    if (renderableIndex >= 0) {
      this._showing = renderableIndex;
      state = this._states[renderableIndex];
      state.halt();
      var outgoingIndex = this._outgoingRenderables.indexOf(renderable);
      if (outgoingIndex >= 0)
        this._outgoingRenderables.splice(outgoingIndex, 1);
    } else {
      state = new Transitionable(0);
      var modifier = new Modifier({
        transform: this.inTransformMap ? _mappedState.bind(this, this.inTransformMap, state) : null,
        opacity: this.inOpacityMap ? _mappedState.bind(this, this.inOpacityMap, state) : null,
        origin: this.inOriginMap ? _mappedState.bind(this, this.inOriginMap, state) : null,
        align: this.inAlignMap ? _mappedState.bind(this, this.inAlignMap, state) : null
      });
      var node = new RenderNode();
      node.add(modifier).add(renderable);
      this._showing = this._nodes.length;
      this._nodes.push(node);
      this._modifiers.push(modifier);
      this._states.push(state);
      this._renderables.push(renderable);
    }
    if (!transition)
      transition = this.options.inTransition;
    state.set(1, transition, callback);
  };
  RenderController.prototype.hide = function hide(transition, callback) {
    if (this._showing < 0)
      return ;
    var index = this._showing;
    this._showing = -1;
    if (transition instanceof Function) {
      callback = transition;
      transition = undefined;
    }
    var node = this._nodes[index];
    var modifier = this._modifiers[index];
    var state = this._states[index];
    var renderable = this._renderables[index];
    modifier.transformFrom(this.outTransformMap ? _mappedState.bind(this, this.outTransformMap, state) : null);
    modifier.opacityFrom(this.outOpacityMap ? _mappedState.bind(this, this.outOpacityMap, state) : null);
    modifier.originFrom(this.outOriginMap ? _mappedState.bind(this, this.outOriginMap, state) : null);
    modifier.alignFrom(this.outAlignMap ? _mappedState.bind(this, this.outAlignMap, state) : null);
    if (this._outgoingRenderables.indexOf(renderable) < 0)
      this._outgoingRenderables.push(renderable);
    if (!transition)
      transition = this.options.outTransition;
    state.halt();
    state.set(0, transition, function(node, modifier, state, renderable) {
      if (this._outgoingRenderables.indexOf(renderable) >= 0) {
        var index = this._nodes.indexOf(node);
        this._nodes.splice(index, 1);
        this._modifiers.splice(index, 1);
        this._states.splice(index, 1);
        this._renderables.splice(index, 1);
        this._outgoingRenderables.splice(this._outgoingRenderables.indexOf(renderable), 1);
        if (this._showing >= index)
          this._showing--;
      }
      if (callback)
        callback.call(this);
    }.bind(this, node, modifier, state, renderable));
  };
  RenderController.prototype.render = function render() {
    var result = this._output;
    if (result.length > this._nodes.length)
      result.splice(this._nodes.length);
    for (var i = 0; i < this._nodes.length; i++) {
      result[i] = this._nodes[i].render();
    }
    return result;
  };
  module.exports = RenderController;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/views/FlexibleLayout", ["npm:famous@0.3.5/core/Entity", "npm:famous@0.3.5/core/Transform", "npm:famous@0.3.5/core/OptionsManager", "npm:famous@0.3.5/core/EventHandler", "npm:famous@0.3.5/transitions/Transitionable"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var Entity = require("npm:famous@0.3.5/core/Entity");
  var Transform = require("npm:famous@0.3.5/core/Transform");
  var OptionsManager = require("npm:famous@0.3.5/core/OptionsManager");
  var EventHandler = require("npm:famous@0.3.5/core/EventHandler");
  var Transitionable = require("npm:famous@0.3.5/transitions/Transitionable");
  function FlexibleLayout(options) {
    this.options = Object.create(FlexibleLayout.DEFAULT_OPTIONS);
    this.optionsManager = new OptionsManager(this.options);
    if (options)
      this.setOptions(options);
    this.id = Entity.register(this);
    this._ratios = new Transitionable(this.options.ratios);
    this._nodes = [];
    this._size = [0, 0];
    this._cachedDirection = null;
    this._cachedLengths = [];
    this._cachedTransforms = null;
    this._ratiosDirty = false;
    this._eventOutput = new EventHandler();
    EventHandler.setOutputHandler(this, this._eventOutput);
  }
  FlexibleLayout.DIRECTION_X = 0;
  FlexibleLayout.DIRECTION_Y = 1;
  FlexibleLayout.DEFAULT_OPTIONS = {
    direction: FlexibleLayout.DIRECTION_X,
    transition: false,
    ratios: []
  };
  function _reflow(ratios, length, direction) {
    var currTransform;
    var translation = 0;
    var flexLength = length;
    var ratioSum = 0;
    var ratio;
    var node;
    var i;
    this._cachedLengths = [];
    this._cachedTransforms = [];
    for (i = 0; i < ratios.length; i++) {
      ratio = ratios[i];
      node = this._nodes[i];
      if (typeof ratio !== 'number')
        flexLength -= node.getSize()[direction] || 0;
      else
        ratioSum += ratio;
    }
    for (i = 0; i < ratios.length; i++) {
      node = this._nodes[i];
      ratio = ratios[i];
      length = typeof ratio === 'number' ? flexLength * ratio / ratioSum : node.getSize()[direction];
      currTransform = direction === FlexibleLayout.DIRECTION_X ? Transform.translate(translation, 0, 0) : Transform.translate(0, translation, 0);
      this._cachedTransforms.push(currTransform);
      this._cachedLengths.push(length);
      translation += length;
    }
  }
  function _trueSizedDirty(ratios, direction) {
    for (var i = 0; i < ratios.length; i++) {
      if (typeof ratios[i] !== 'number') {
        if (this._nodes[i].getSize()[direction] !== this._cachedLengths[i])
          return true;
      }
    }
    return false;
  }
  FlexibleLayout.prototype.render = function render() {
    return this.id;
  };
  FlexibleLayout.prototype.setOptions = function setOptions(options) {
    this.optionsManager.setOptions(options);
  };
  FlexibleLayout.prototype.sequenceFrom = function sequenceFrom(sequence) {
    this._nodes = sequence;
    if (this._ratios.get().length === 0) {
      var ratios = [];
      for (var i = 0; i < this._nodes.length; i++)
        ratios.push(1);
      this.setRatios(ratios);
    }
  };
  FlexibleLayout.prototype.setRatios = function setRatios(ratios, transition, callback) {
    if (transition === undefined)
      transition = this.options.transition;
    var currRatios = this._ratios;
    if (currRatios.get().length === 0)
      transition = undefined;
    if (currRatios.isActive())
      currRatios.halt();
    currRatios.set(ratios, transition, callback);
    this._ratiosDirty = true;
  };
  FlexibleLayout.prototype.getSize = function getSize() {
    return this._size;
  };
  FlexibleLayout.prototype.commit = function commit(context) {
    var parentSize = context.size;
    var parentTransform = context.transform;
    var parentOrigin = context.origin;
    var parentOpacity = context.opacity;
    var ratios = this._ratios.get();
    var direction = this.options.direction;
    var length = parentSize[direction];
    var size;
    if (length !== this._size[direction] || this._ratiosDirty || this._ratios.isActive() || direction !== this._cachedDirection || _trueSizedDirty.call(this, ratios, direction)) {
      _reflow.call(this, ratios, length, direction);
      if (length !== this._size[direction]) {
        this._size[0] = parentSize[0];
        this._size[1] = parentSize[1];
      }
      if (direction !== this._cachedDirection)
        this._cachedDirection = direction;
      if (this._ratiosDirty)
        this._ratiosDirty = false;
    }
    var result = [];
    for (var i = 0; i < ratios.length; i++) {
      size = [undefined, undefined];
      length = this._cachedLengths[i];
      size[direction] = length;
      result.push({
        transform: this._cachedTransforms[i],
        size: size,
        target: this._nodes[i].render()
      });
    }
    if (parentSize && (parentOrigin[0] !== 0 && parentOrigin[1] !== 0))
      parentTransform = Transform.moveThen([-parentSize[0] * parentOrigin[0], -parentSize[1] * parentOrigin[1], 0], parentTransform);
    return {
      transform: parentTransform,
      size: parentSize,
      opacity: parentOpacity,
      target: result
    };
  };
  module.exports = FlexibleLayout;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/views/Flipper", ["npm:famous@0.3.5/core/Transform", "npm:famous@0.3.5/transitions/Transitionable", "npm:famous@0.3.5/core/RenderNode", "npm:famous@0.3.5/core/OptionsManager"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var Transform = require("npm:famous@0.3.5/core/Transform");
  var Transitionable = require("npm:famous@0.3.5/transitions/Transitionable");
  var RenderNode = require("npm:famous@0.3.5/core/RenderNode");
  var OptionsManager = require("npm:famous@0.3.5/core/OptionsManager");
  function Flipper(options) {
    this.options = Object.create(Flipper.DEFAULT_OPTIONS);
    this._optionsManager = new OptionsManager(this.options);
    if (options)
      this.setOptions(options);
    this.angle = new Transitionable(0);
    this.frontNode = undefined;
    this.backNode = undefined;
    this.flipped = false;
  }
  Flipper.DIRECTION_X = 0;
  Flipper.DIRECTION_Y = 1;
  var SEPERATION_LENGTH = 1;
  Flipper.DEFAULT_OPTIONS = {
    transition: true,
    direction: Flipper.DIRECTION_X
  };
  Flipper.prototype.flip = function flip(transition, callback) {
    var angle = this.flipped ? 0 : Math.PI;
    this.setAngle(angle, transition, callback);
    this.flipped = !this.flipped;
  };
  Flipper.prototype.setAngle = function setAngle(angle, transition, callback) {
    if (transition === undefined)
      transition = this.options.transition;
    if (this.angle.isActive())
      this.angle.halt();
    this.angle.set(angle, transition, callback);
  };
  Flipper.prototype.setOptions = function setOptions(options) {
    return this._optionsManager.setOptions(options);
  };
  Flipper.prototype.setFront = function setFront(node) {
    this.frontNode = node;
  };
  Flipper.prototype.setBack = function setBack(node) {
    this.backNode = node;
  };
  Flipper.prototype.render = function render() {
    var angle = this.angle.get();
    var frontTransform;
    var backTransform;
    if (this.options.direction === Flipper.DIRECTION_X) {
      frontTransform = Transform.rotateY(angle);
      backTransform = Transform.rotateY(angle + Math.PI);
    } else {
      frontTransform = Transform.rotateX(angle);
      backTransform = Transform.rotateX(angle + Math.PI);
    }
    var result = [];
    if (this.frontNode) {
      result.push({
        transform: frontTransform,
        target: this.frontNode.render()
      });
    }
    if (this.backNode) {
      result.push({
        transform: Transform.moveThen([0, 0, SEPERATION_LENGTH], backTransform),
        target: this.backNode.render()
      });
    }
    return result;
  };
  module.exports = Flipper;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/views/GridLayout", ["npm:famous@0.3.5/core/Entity", "npm:famous@0.3.5/core/RenderNode", "npm:famous@0.3.5/core/Transform", "npm:famous@0.3.5/core/ViewSequence", "npm:famous@0.3.5/core/EventHandler", "npm:famous@0.3.5/core/Modifier", "npm:famous@0.3.5/core/OptionsManager", "npm:famous@0.3.5/transitions/Transitionable", "npm:famous@0.3.5/transitions/TransitionableTransform"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var Entity = require("npm:famous@0.3.5/core/Entity");
  var RenderNode = require("npm:famous@0.3.5/core/RenderNode");
  var Transform = require("npm:famous@0.3.5/core/Transform");
  var ViewSequence = require("npm:famous@0.3.5/core/ViewSequence");
  var EventHandler = require("npm:famous@0.3.5/core/EventHandler");
  var Modifier = require("npm:famous@0.3.5/core/Modifier");
  var OptionsManager = require("npm:famous@0.3.5/core/OptionsManager");
  var Transitionable = require("npm:famous@0.3.5/transitions/Transitionable");
  var TransitionableTransform = require("npm:famous@0.3.5/transitions/TransitionableTransform");
  function GridLayout(options) {
    this.options = Object.create(GridLayout.DEFAULT_OPTIONS);
    this.optionsManager = new OptionsManager(this.options);
    if (options)
      this.setOptions(options);
    this.id = Entity.register(this);
    this._modifiers = [];
    this._states = [];
    this._contextSizeCache = [0, 0];
    this._dimensionsCache = [0, 0];
    this._activeCount = 0;
    this._eventOutput = new EventHandler();
    EventHandler.setOutputHandler(this, this._eventOutput);
  }
  function _reflow(size, cols, rows) {
    var usableSize = [size[0], size[1]];
    usableSize[0] -= this.options.gutterSize[0] * (cols - 1);
    usableSize[1] -= this.options.gutterSize[1] * (rows - 1);
    var rowSize = Math.round(usableSize[1] / rows);
    var colSize = Math.round(usableSize[0] / cols);
    var currY = 0;
    var currX;
    var currIndex = 0;
    for (var i = 0; i < rows; i++) {
      currX = 0;
      for (var j = 0; j < cols; j++) {
        if (this._modifiers[currIndex] === undefined) {
          _createModifier.call(this, currIndex, [colSize, rowSize], [currX, currY, 0], 1);
        } else {
          _animateModifier.call(this, currIndex, [colSize, rowSize], [currX, currY, 0], 1);
        }
        currIndex++;
        currX += colSize + this.options.gutterSize[0];
      }
      currY += rowSize + this.options.gutterSize[1];
    }
    this._dimensionsCache = [this.options.dimensions[0], this.options.dimensions[1]];
    this._contextSizeCache = [size[0], size[1]];
    this._activeCount = rows * cols;
    for (i = this._activeCount; i < this._modifiers.length; i++)
      _animateModifier.call(this, i, [Math.round(colSize), Math.round(rowSize)], [0, 0], 0);
    this._eventOutput.emit('reflow');
  }
  function _createModifier(index, size, position, opacity) {
    var transitionItem = {
      transform: new TransitionableTransform(Transform.translate.apply(null, position)),
      opacity: new Transitionable(opacity),
      size: new Transitionable(size)
    };
    var modifier = new Modifier({
      transform: transitionItem.transform,
      opacity: transitionItem.opacity,
      size: transitionItem.size
    });
    this._states[index] = transitionItem;
    this._modifiers[index] = modifier;
  }
  function _animateModifier(index, size, position, opacity) {
    var currState = this._states[index];
    var currSize = currState.size;
    var currOpacity = currState.opacity;
    var currTransform = currState.transform;
    var transition = this.options.transition;
    currTransform.halt();
    currOpacity.halt();
    currSize.halt();
    currTransform.setTranslate(position, transition);
    currSize.set(size, transition);
    currOpacity.set(opacity, transition);
  }
  GridLayout.DEFAULT_OPTIONS = {
    dimensions: [1, 1],
    transition: false,
    gutterSize: [0, 0]
  };
  GridLayout.prototype.render = function render() {
    return this.id;
  };
  GridLayout.prototype.setOptions = function setOptions(options) {
    return this.optionsManager.setOptions(options);
  };
  GridLayout.prototype.sequenceFrom = function sequenceFrom(sequence) {
    if (sequence instanceof Array)
      sequence = new ViewSequence(sequence);
    this.sequence = sequence;
  };
  GridLayout.prototype.getSize = function getSize() {
    return this._contextSizeCache;
  };
  GridLayout.prototype.commit = function commit(context) {
    var transform = context.transform;
    var opacity = context.opacity;
    var origin = context.origin;
    var size = context.size;
    var cols = this.options.dimensions[0];
    var rows = this.options.dimensions[1];
    if (size[0] !== this._contextSizeCache[0] || size[1] !== this._contextSizeCache[1] || cols !== this._dimensionsCache[0] || rows !== this._dimensionsCache[1]) {
      _reflow.call(this, size, cols, rows);
    }
    var sequence = this.sequence;
    var result = [];
    var currIndex = 0;
    while (sequence && currIndex < this._modifiers.length) {
      var item = sequence.get();
      var modifier = this._modifiers[currIndex];
      if (currIndex >= this._activeCount && this._states[currIndex].opacity.isActive()) {
        this._modifiers.splice(currIndex, 1);
        this._states.splice(currIndex, 1);
      }
      if (item) {
        result.push(modifier.modify({
          origin: origin,
          target: item.render()
        }));
      }
      sequence = sequence.getNext();
      currIndex++;
    }
    if (size)
      transform = Transform.moveThen([-size[0] * origin[0], -size[1] * origin[1], 0], transform);
    return {
      transform: transform,
      opacity: opacity,
      size: size,
      target: result
    };
  };
  module.exports = GridLayout;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/views/HeaderFooterLayout", ["npm:famous@0.3.5/core/Entity", "npm:famous@0.3.5/core/RenderNode", "npm:famous@0.3.5/core/Transform", "npm:famous@0.3.5/core/OptionsManager"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var Entity = require("npm:famous@0.3.5/core/Entity");
  var RenderNode = require("npm:famous@0.3.5/core/RenderNode");
  var Transform = require("npm:famous@0.3.5/core/Transform");
  var OptionsManager = require("npm:famous@0.3.5/core/OptionsManager");
  function HeaderFooterLayout(options) {
    this.options = Object.create(HeaderFooterLayout.DEFAULT_OPTIONS);
    this._optionsManager = new OptionsManager(this.options);
    if (options)
      this.setOptions(options);
    this._entityId = Entity.register(this);
    this.header = new RenderNode();
    this.footer = new RenderNode();
    this.content = new RenderNode();
  }
  HeaderFooterLayout.DIRECTION_X = 0;
  HeaderFooterLayout.DIRECTION_Y = 1;
  HeaderFooterLayout.DEFAULT_OPTIONS = {
    direction: HeaderFooterLayout.DIRECTION_Y,
    headerSize: undefined,
    footerSize: undefined,
    defaultHeaderSize: 0,
    defaultFooterSize: 0
  };
  HeaderFooterLayout.prototype.render = function render() {
    return this._entityId;
  };
  HeaderFooterLayout.prototype.setOptions = function setOptions(options) {
    return this._optionsManager.setOptions(options);
  };
  function _resolveNodeSize(node, defaultSize) {
    var nodeSize = node.getSize();
    return nodeSize ? nodeSize[this.options.direction] : defaultSize;
  }
  function _outputTransform(offset) {
    if (this.options.direction === HeaderFooterLayout.DIRECTION_X)
      return Transform.translate(offset, 0, 0);
    else
      return Transform.translate(0, offset, 0);
  }
  function _finalSize(directionSize, size) {
    if (this.options.direction === HeaderFooterLayout.DIRECTION_X)
      return [directionSize, size[1]];
    else
      return [size[0], directionSize];
  }
  HeaderFooterLayout.prototype.commit = function commit(context) {
    var transform = context.transform;
    var origin = context.origin;
    var size = context.size;
    var opacity = context.opacity;
    var headerSize = this.options.headerSize !== undefined ? this.options.headerSize : _resolveNodeSize.call(this, this.header, this.options.defaultHeaderSize);
    var footerSize = this.options.footerSize !== undefined ? this.options.footerSize : _resolveNodeSize.call(this, this.footer, this.options.defaultFooterSize);
    var contentSize = size[this.options.direction] - headerSize - footerSize;
    if (size)
      transform = Transform.moveThen([-size[0] * origin[0], -size[1] * origin[1], 0], transform);
    var result = [{
      size: _finalSize.call(this, headerSize, size),
      target: this.header.render()
    }, {
      transform: _outputTransform.call(this, headerSize),
      size: _finalSize.call(this, contentSize, size),
      target: this.content.render()
    }, {
      transform: _outputTransform.call(this, headerSize + contentSize),
      size: _finalSize.call(this, footerSize, size),
      target: this.footer.render()
    }];
    return {
      transform: transform,
      opacity: opacity,
      size: size,
      target: result
    };
  };
  module.exports = HeaderFooterLayout;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/views/Lightbox", ["npm:famous@0.3.5/core/Transform", "npm:famous@0.3.5/core/Modifier", "npm:famous@0.3.5/core/RenderNode", "npm:famous@0.3.5/utilities/Utility", "npm:famous@0.3.5/core/OptionsManager", "npm:famous@0.3.5/transitions/Transitionable", "npm:famous@0.3.5/transitions/TransitionableTransform"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var Transform = require("npm:famous@0.3.5/core/Transform");
  var Modifier = require("npm:famous@0.3.5/core/Modifier");
  var RenderNode = require("npm:famous@0.3.5/core/RenderNode");
  var Utility = require("npm:famous@0.3.5/utilities/Utility");
  var OptionsManager = require("npm:famous@0.3.5/core/OptionsManager");
  var Transitionable = require("npm:famous@0.3.5/transitions/Transitionable");
  var TransitionableTransform = require("npm:famous@0.3.5/transitions/TransitionableTransform");
  function Lightbox(options) {
    this.options = Object.create(Lightbox.DEFAULT_OPTIONS);
    this._optionsManager = new OptionsManager(this.options);
    if (options)
      this.setOptions(options);
    this._showing = false;
    this.nodes = [];
    this.transforms = [];
    this.states = [];
  }
  Lightbox.DEFAULT_OPTIONS = {
    inTransform: Transform.scale(0.001, 0.001, 0.001),
    inOpacity: 0,
    inOrigin: [0.5, 0.5],
    inAlign: [0.5, 0.5],
    outTransform: Transform.scale(0.001, 0.001, 0.001),
    outOpacity: 0,
    outOrigin: [0.5, 0.5],
    outAlign: [0.5, 0.5],
    showTransform: Transform.identity,
    showOpacity: 1,
    showOrigin: [0.5, 0.5],
    showAlign: [0.5, 0.5],
    inTransition: true,
    outTransition: true,
    overlap: false
  };
  Lightbox.prototype.setOptions = function setOptions(options) {
    return this._optionsManager.setOptions(options);
  };
  Lightbox.prototype.show = function show(renderable, transition, callback) {
    if (!renderable) {
      return this.hide(callback);
    }
    if (transition instanceof Function) {
      callback = transition;
      transition = undefined;
    }
    if (this._showing) {
      if (this.options.overlap)
        this.hide();
      else {
        return this.hide(this.show.bind(this, renderable, transition, callback));
      }
    }
    this._showing = true;
    var stateItem = {
      transform: new TransitionableTransform(this.options.inTransform),
      origin: new Transitionable(this.options.inOrigin),
      align: new Transitionable(this.options.inAlign),
      opacity: new Transitionable(this.options.inOpacity)
    };
    var transform = new Modifier({
      transform: stateItem.transform,
      opacity: stateItem.opacity,
      origin: stateItem.origin,
      align: stateItem.align
    });
    var node = new RenderNode();
    node.add(transform).add(renderable);
    this.nodes.push(node);
    this.states.push(stateItem);
    this.transforms.push(transform);
    var _cb = callback ? Utility.after(3, callback) : undefined;
    if (!transition)
      transition = this.options.inTransition;
    stateItem.transform.set(this.options.showTransform, transition, _cb);
    stateItem.opacity.set(this.options.showOpacity, transition, _cb);
    stateItem.origin.set(this.options.showOrigin, transition, _cb);
    stateItem.align.set(this.options.showAlign, transition, _cb);
  };
  Lightbox.prototype.hide = function hide(transition, callback) {
    if (!this._showing)
      return ;
    this._showing = false;
    if (transition instanceof Function) {
      callback = transition;
      transition = undefined;
    }
    var node = this.nodes[this.nodes.length - 1];
    var transform = this.transforms[this.transforms.length - 1];
    var stateItem = this.states[this.states.length - 1];
    var _cb = Utility.after(3, function() {
      this.nodes.splice(this.nodes.indexOf(node), 1);
      this.states.splice(this.states.indexOf(stateItem), 1);
      this.transforms.splice(this.transforms.indexOf(transform), 1);
      if (callback)
        callback.call(this);
    }.bind(this));
    if (!transition)
      transition = this.options.outTransition;
    stateItem.transform.set(this.options.outTransform, transition, _cb);
    stateItem.opacity.set(this.options.outOpacity, transition, _cb);
    stateItem.origin.set(this.options.outOrigin, transition, _cb);
    stateItem.align.set(this.options.outAlign, transition, _cb);
  };
  Lightbox.prototype.render = function render() {
    var result = [];
    for (var i = 0; i < this.nodes.length; i++) {
      result.push(this.nodes[i].render());
    }
    return result;
  };
  module.exports = Lightbox;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/views/Scroller", ["npm:famous@0.3.5/core/Entity", "npm:famous@0.3.5/core/Group", "npm:famous@0.3.5/core/OptionsManager", "npm:famous@0.3.5/core/Transform", "npm:famous@0.3.5/utilities/Utility", "npm:famous@0.3.5/core/ViewSequence", "npm:famous@0.3.5/core/EventHandler"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var Entity = require("npm:famous@0.3.5/core/Entity");
  var Group = require("npm:famous@0.3.5/core/Group");
  var OptionsManager = require("npm:famous@0.3.5/core/OptionsManager");
  var Transform = require("npm:famous@0.3.5/core/Transform");
  var Utility = require("npm:famous@0.3.5/utilities/Utility");
  var ViewSequence = require("npm:famous@0.3.5/core/ViewSequence");
  var EventHandler = require("npm:famous@0.3.5/core/EventHandler");
  function Scroller(options) {
    this.options = Object.create(this.constructor.DEFAULT_OPTIONS);
    this._optionsManager = new OptionsManager(this.options);
    if (options)
      this._optionsManager.setOptions(options);
    this._node = null;
    this._position = 0;
    this._positionOffset = 0;
    this._positionGetter = null;
    this._outputFunction = null;
    this._masterOutputFunction = null;
    this.outputFrom();
    this._onEdge = 0;
    this.group = new Group();
    this.group.add({render: _innerRender.bind(this)});
    this._entityId = Entity.register(this);
    this._size = [undefined, undefined];
    this._contextSize = [undefined, undefined];
    this._eventInput = new EventHandler();
    this._eventOutput = new EventHandler();
    EventHandler.setInputHandler(this, this._eventInput);
    EventHandler.setOutputHandler(this, this._eventOutput);
  }
  Scroller.DEFAULT_OPTIONS = {
    direction: Utility.Direction.Y,
    margin: 0,
    clipSize: undefined,
    groupScroll: false
  };
  var EDGE_TOLERANCE = 0;
  function _sizeForDir(size) {
    if (!size)
      size = this._contextSize;
    var dimension = this.options.direction;
    return size[dimension] === undefined ? this._contextSize[dimension] : size[dimension];
  }
  function _output(node, offset, target) {
    var size = node.getSize ? node.getSize() : this._contextSize;
    var transform = this._outputFunction(offset);
    target.push({
      transform: transform,
      target: node.render()
    });
    return _sizeForDir.call(this, size);
  }
  function _getClipSize() {
    if (this.options.clipSize !== undefined)
      return this.options.clipSize;
    if (this._contextSize[this.options.direction] > this.getCumulativeSize()[this.options.direction]) {
      return _sizeForDir.call(this, this.getCumulativeSize());
    } else {
      return _sizeForDir.call(this, this._contextSize);
    }
  }
  Scroller.prototype.getCumulativeSize = function(index) {
    if (index === undefined)
      index = this._node._.cumulativeSizes.length - 1;
    return this._node._.getSize(index);
  };
  Scroller.prototype.setOptions = function setOptions(options) {
    if (options.groupScroll !== this.options.groupScroll) {
      if (options.groupScroll)
        this.group.pipe(this._eventOutput);
      else
        this.group.unpipe(this._eventOutput);
    }
    this._optionsManager.setOptions(options);
  };
  Scroller.prototype.onEdge = function onEdge() {
    return this._onEdge;
  };
  Scroller.prototype.outputFrom = function outputFrom(fn, masterFn) {
    if (!fn) {
      fn = function(offset) {
        return this.options.direction === Utility.Direction.X ? Transform.translate(offset, 0) : Transform.translate(0, offset);
      }.bind(this);
      if (!masterFn)
        masterFn = fn;
    }
    this._outputFunction = fn;
    this._masterOutputFunction = masterFn ? masterFn : function(offset) {
      return Transform.inverse(fn(-offset));
    };
  };
  Scroller.prototype.positionFrom = function positionFrom(position) {
    if (position instanceof Function)
      this._positionGetter = position;
    else if (position && position.get)
      this._positionGetter = position.get.bind(position);
    else {
      this._positionGetter = null;
      this._position = position;
    }
    if (this._positionGetter)
      this._position = this._positionGetter.call(this);
  };
  Scroller.prototype.sequenceFrom = function sequenceFrom(node) {
    if (node instanceof Array)
      node = new ViewSequence({array: node});
    this._node = node;
    this._positionOffset = 0;
  };
  Scroller.prototype.getSize = function getSize(actual) {
    return actual ? this._contextSize : this._size;
  };
  Scroller.prototype.render = function render() {
    if (!this._node)
      return null;
    if (this._positionGetter)
      this._position = this._positionGetter.call(this);
    return this._entityId;
  };
  Scroller.prototype.commit = function commit(context) {
    var transform = context.transform;
    var opacity = context.opacity;
    var origin = context.origin;
    var size = context.size;
    if (!this.options.clipSize && (size[0] !== this._contextSize[0] || size[1] !== this._contextSize[1])) {
      this._onEdge = 0;
      this._contextSize[0] = size[0];
      this._contextSize[1] = size[1];
      if (this.options.direction === Utility.Direction.X) {
        this._size[0] = _getClipSize.call(this);
        this._size[1] = undefined;
      } else {
        this._size[0] = undefined;
        this._size[1] = _getClipSize.call(this);
      }
    }
    var scrollTransform = this._masterOutputFunction(-this._position);
    return {
      transform: Transform.multiply(transform, scrollTransform),
      size: size,
      opacity: opacity,
      origin: origin,
      target: this.group.render()
    };
  };
  function _innerRender() {
    var size = null;
    var position = this._position;
    var result = [];
    var offset = -this._positionOffset;
    var clipSize = _getClipSize.call(this);
    var currNode = this._node;
    while (currNode && offset - position < clipSize + this.options.margin) {
      offset += _output.call(this, currNode, offset, result);
      currNode = currNode.getNext ? currNode.getNext() : null;
    }
    var sizeNode = this._node;
    var nodesSize = _sizeForDir.call(this, sizeNode.getSize());
    if (offset < clipSize) {
      while (sizeNode && nodesSize < clipSize) {
        sizeNode = sizeNode.getPrevious();
        if (sizeNode)
          nodesSize += _sizeForDir.call(this, sizeNode.getSize());
      }
      sizeNode = this._node;
      while (sizeNode && nodesSize < clipSize) {
        sizeNode = sizeNode.getNext();
        if (sizeNode)
          nodesSize += _sizeForDir.call(this, sizeNode.getSize());
      }
    }
    if (!currNode && offset - position < clipSize - EDGE_TOLERANCE) {
      if (this._onEdge !== 1) {
        this._onEdge = 1;
        this._eventOutput.emit('onEdge', {position: offset - clipSize});
      }
    } else if (!this._node.getPrevious() && position < -EDGE_TOLERANCE) {
      if (this._onEdge !== -1) {
        this._onEdge = -1;
        this._eventOutput.emit('onEdge', {position: 0});
      }
    } else {
      if (this._onEdge !== 0) {
        this._onEdge = 0;
        this._eventOutput.emit('offEdge');
      }
    }
    currNode = this._node && this._node.getPrevious ? this._node.getPrevious() : null;
    offset = -this._positionOffset;
    if (currNode) {
      size = currNode.getSize ? currNode.getSize() : this._contextSize;
      offset -= _sizeForDir.call(this, size);
    }
    while (currNode && offset - position > -(clipSize + this.options.margin)) {
      _output.call(this, currNode, offset, result);
      currNode = currNode.getPrevious ? currNode.getPrevious() : null;
      if (currNode) {
        size = currNode.getSize ? currNode.getSize() : this._contextSize;
        offset -= _sizeForDir.call(this, size);
      }
    }
    return result;
  }
  module.exports = Scroller;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/views/SizeAwareView", ["npm:famous@0.3.5/core/View", "npm:famous@0.3.5/core/Entity", "npm:famous@0.3.5/core/Transform"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var View = require("npm:famous@0.3.5/core/View");
  var Entity = require("npm:famous@0.3.5/core/Entity");
  var Transform = require("npm:famous@0.3.5/core/Transform");
  function SizeAwareView() {
    View.apply(this, arguments);
    this._id = Entity.register(this);
    this._parentSize = [];
  }
  SizeAwareView.prototype = Object.create(View.prototype);
  SizeAwareView.prototype.constructor = SizeAwareView;
  SizeAwareView.prototype.commit = function commit(context) {
    var transform = context.transform;
    var opacity = context.opacity;
    var origin = context.origin;
    if (!this._parentSize || this._parentSize[0] !== context.size[0] || this._parentSize[1] !== context.size[1]) {
      this._parentSize[0] = context.size[0];
      this._parentSize[1] = context.size[1];
      this._eventInput.emit('parentResize', this._parentSize);
      if (this.onResize)
        this.onResize(this._parentSize);
    }
    if (this._parentSize) {
      transform = Transform.moveThen([-this._parentSize[0] * origin[0], -this._parentSize[1] * origin[1], 0], transform);
    }
    return {
      transform: transform,
      opacity: opacity,
      size: this._parentSize,
      target: this._node.render()
    };
  };
  SizeAwareView.prototype.getParentSize = function getParentSize() {
    return this._parentSize;
  };
  SizeAwareView.prototype.render = function render() {
    return this._id;
  };
  module.exports = SizeAwareView;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/widgets/NavigationBar", ["npm:famous@0.3.5/core/Scene", "npm:famous@0.3.5/core/Surface", "npm:famous@0.3.5/core/Transform", "npm:famous@0.3.5/core/View"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var Scene = require("npm:famous@0.3.5/core/Scene");
  var Surface = require("npm:famous@0.3.5/core/Surface");
  var Transform = require("npm:famous@0.3.5/core/Transform");
  var View = require("npm:famous@0.3.5/core/View");
  function NavigationBar(options) {
    View.apply(this, arguments);
    this.title = new Surface({
      classes: this.options.classes,
      content: this.options.content
    });
    this.back = new Surface({
      size: [this.options.size[1], this.options.size[1]],
      classes: this.options.classes,
      content: this.options.backContent
    });
    this.back.on('click', function() {
      this._eventOutput.emit('back', {});
    }.bind(this));
    this.more = new Surface({
      size: [this.options.size[1], this.options.size[1]],
      classes: this.options.classes,
      content: this.options.moreContent
    });
    this.more.on('click', function() {
      this._eventOutput.emit('more', {});
    }.bind(this));
    this.layout = new Scene({
      id: 'master',
      size: this.options.size,
      target: [{
        transform: Transform.inFront,
        origin: [0, 0.5],
        align: [0, 0.5],
        target: this.back
      }, {
        origin: [0.5, 0.5],
        align: [0.5, 0.5],
        target: this.title
      }, {
        transform: Transform.inFront,
        origin: [1, 0.5],
        align: [1, 0.5],
        target: this.more
      }]
    });
    this._add(this.layout);
    this._optionsManager.on('change', function(event) {
      var key = event.id;
      var data = event.value;
      if (key === 'size') {
        this.layout.id.master.setSize(data);
        this.title.setSize(data);
        this.back.setSize([data[1], data[1]]);
        this.more.setSize([data[1], data[1]]);
      } else if (key === 'backClasses') {
        this.back.setOptions({classes: this.options.classes.concat(this.options.backClasses)});
      } else if (key === 'backContent') {
        this.back.setContent(this.options.backContent);
      } else if (key === 'classes') {
        this.title.setOptions({classes: this.options.classes});
        this.back.setOptions({classes: this.options.classes.concat(this.options.backClasses)});
        this.more.setOptions({classes: this.options.classes.concat(this.options.moreClasses)});
      } else if (key === 'content') {
        this.setContent(this.options.content);
      } else if (key === 'moreClasses') {
        this.more.setOptions({classes: this.options.classes.concat(this.options.moreClasses)});
      } else if (key === 'moreContent') {
        this.more.setContent(this.options.content);
      }
    }.bind(this));
  }
  NavigationBar.prototype = Object.create(View.prototype);
  NavigationBar.prototype.constructor = NavigationBar;
  NavigationBar.DEFAULT_OPTIONS = {
    size: [undefined, 50],
    backClasses: ['back'],
    backContent: '&#x25c0;',
    classes: ['navigation'],
    content: '',
    moreClasses: ['more'],
    moreContent: '&#x271a;'
  };
  NavigationBar.prototype.setContent = function setContent(content) {
    return this.title.setContent(content);
  };
  module.exports = NavigationBar;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/widgets/Slider", ["npm:famous@0.3.5/core/Surface", "npm:famous@0.3.5/surfaces/CanvasSurface", "npm:famous@0.3.5/core/Transform", "npm:famous@0.3.5/core/EventHandler", "npm:famous@0.3.5/math/Utilities", "npm:famous@0.3.5/core/OptionsManager", "npm:famous@0.3.5/inputs/MouseSync", "npm:famous@0.3.5/inputs/TouchSync", "npm:famous@0.3.5/inputs/GenericSync"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var Surface = require("npm:famous@0.3.5/core/Surface");
  var CanvasSurface = require("npm:famous@0.3.5/surfaces/CanvasSurface");
  var Transform = require("npm:famous@0.3.5/core/Transform");
  var EventHandler = require("npm:famous@0.3.5/core/EventHandler");
  var Utilities = require("npm:famous@0.3.5/math/Utilities");
  var OptionsManager = require("npm:famous@0.3.5/core/OptionsManager");
  var MouseSync = require("npm:famous@0.3.5/inputs/MouseSync");
  var TouchSync = require("npm:famous@0.3.5/inputs/TouchSync");
  var GenericSync = require("npm:famous@0.3.5/inputs/GenericSync");
  GenericSync.register({
    mouse: MouseSync,
    touch: TouchSync
  });
  function Slider(options) {
    this.options = Object.create(Slider.DEFAULT_OPTIONS);
    this.optionsManager = new OptionsManager(this.options);
    if (options)
      this.setOptions(options);
    this.indicator = new CanvasSurface({
      size: this.options.indicatorSize,
      classes: ['slider-back']
    });
    this.label = new Surface({
      size: this.options.labelSize,
      content: this.options.label,
      properties: {pointerEvents: 'none'},
      classes: ['slider-label']
    });
    this.eventOutput = new EventHandler();
    this.eventInput = new EventHandler();
    EventHandler.setInputHandler(this, this.eventInput);
    EventHandler.setOutputHandler(this, this.eventOutput);
    var scale = (this.options.range[1] - this.options.range[0]) / this.options.indicatorSize[0];
    this.sync = new GenericSync(['mouse', 'touch'], {
      scale: scale,
      direction: GenericSync.DIRECTION_X
    });
    this.indicator.pipe(this.sync);
    this.sync.pipe(this);
    this.eventInput.on('update', function(data) {
      this.set(data.position);
    }.bind(this));
    this._drawPos = 0;
    _updateLabel.call(this);
  }
  Slider.DEFAULT_OPTIONS = {
    size: [200, 60],
    indicatorSize: [200, 30],
    labelSize: [200, 30],
    range: [0, 1],
    precision: 2,
    value: 0,
    label: '',
    fillColor: 'rgba(170, 170, 170, 1)'
  };
  function _updateLabel() {
    this.label.setContent(this.options.label + '<span style="float: right">' + this.get().toFixed(this.options.precision) + '</span>');
  }
  Slider.prototype.setOptions = function setOptions(options) {
    return this.optionsManager.setOptions(options);
  };
  Slider.prototype.get = function get() {
    return this.options.value;
  };
  Slider.prototype.set = function set(value) {
    if (value === this.options.value)
      return ;
    this.options.value = Utilities.clamp(value, this.options.range);
    _updateLabel.call(this);
    this.eventOutput.emit('change', {value: value});
  };
  Slider.prototype.getSize = function getSize() {
    return this.options.size;
  };
  Slider.prototype.render = function render() {
    var range = this.options.range;
    var fillSize = Math.floor((this.get() - range[0]) / (range[1] - range[0]) * this.options.indicatorSize[0]);
    if (fillSize < this._drawPos) {
      this.indicator.getContext('2d').clearRect(fillSize, 0, this._drawPos - fillSize + 1, this.options.indicatorSize[1]);
    } else if (fillSize > this._drawPos) {
      var ctx = this.indicator.getContext('2d');
      ctx.fillStyle = this.options.fillColor;
      ctx.fillRect(this._drawPos - 1, 0, fillSize - this._drawPos + 1, this.options.indicatorSize[1]);
    }
    this._drawPos = fillSize;
    return {
      size: this.options.size,
      target: [{
        origin: [0, 0],
        target: this.indicator.render()
      }, {
        transform: Transform.translate(0, 0, 1),
        origin: [0, 0],
        target: this.label.render()
      }]
    };
  };
  module.exports = Slider;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/widgets/ToggleButton", ["npm:famous@0.3.5/core/Surface", "npm:famous@0.3.5/core/EventHandler", "npm:famous@0.3.5/views/RenderController"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var Surface = require("npm:famous@0.3.5/core/Surface");
  var EventHandler = require("npm:famous@0.3.5/core/EventHandler");
  var RenderController = require("npm:famous@0.3.5/views/RenderController");
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
  global.define = __define;
  return module.exports;
});



(function() {
function define(){};  define.amd = {};
System.register("github:IjzerenHein/famous-flex@0.2.0/src/LayoutUtility", ["npm:famous@0.3.5/utilities/Utility"], false, function(__require, __exports, __module) {
  return (function(require, exports, module) {
    var Utility = require("npm:famous@0.3.5/utilities/Utility");
    function LayoutUtility() {}
    LayoutUtility.registeredHelpers = {};
    var Capabilities = {
      SEQUENCE: 1,
      DIRECTION_X: 2,
      DIRECTION_Y: 4,
      SCROLLING: 8
    };
    LayoutUtility.Capabilities = Capabilities;
    LayoutUtility.normalizeMargins = function(margins) {
      if (!margins) {
        return [0, 0, 0, 0];
      } else if (!Array.isArray(margins)) {
        return [margins, margins, margins, margins];
      } else if (margins.length === 0) {
        return [0, 0, 0, 0];
      } else if (margins.length === 1) {
        return [margins[0], margins[0], margins[0], margins[0]];
      } else if (margins.length === 2) {
        return [margins[0], margins[1], margins[0], margins[1]];
      } else {
        return margins;
      }
    };
    LayoutUtility.cloneSpec = function(spec) {
      var clone = {};
      if (spec.opacity !== undefined) {
        clone.opacity = spec.opacity;
      }
      if (spec.size !== undefined) {
        clone.size = spec.size.slice(0);
      }
      if (spec.transform !== undefined) {
        clone.transform = spec.transform.slice(0);
      }
      if (spec.origin !== undefined) {
        clone.origin = spec.origin.slice(0);
      }
      if (spec.align !== undefined) {
        clone.align = spec.align.slice(0);
      }
      return clone;
    };
    function _isEqualArray(a, b) {
      if (a === b) {
        return true;
      }
      if ((a === undefined) || (b === undefined)) {
        return false;
      }
      var i = a.length;
      if (i !== b.length) {
        return false;
      }
      while (i--) {
        if (a[i] !== b[i]) {
          return false;
        }
      }
      return true;
    }
    LayoutUtility.isEqualSpec = function(spec1, spec2) {
      if (spec1.opacity !== spec2.opacity) {
        return false;
      }
      if (!_isEqualArray(spec1.size, spec2.size)) {
        return false;
      }
      if (!_isEqualArray(spec1.transform, spec2.transform)) {
        return false;
      }
      if (!_isEqualArray(spec1.origin, spec2.origin)) {
        return false;
      }
      if (!_isEqualArray(spec1.align, spec2.align)) {
        return false;
      }
      return true;
    };
    LayoutUtility.getSpecDiffText = function(spec1, spec2) {
      var result = 'spec diff:';
      if (spec1.opacity !== spec2.opacity) {
        result += '\nopacity: ' + spec1.opacity + ' != ' + spec2.opacity;
      }
      if (!_isEqualArray(spec1.size, spec2.size)) {
        result += '\nsize: ' + JSON.stringify(spec1.size) + ' != ' + JSON.stringify(spec2.size);
      }
      if (!_isEqualArray(spec1.transform, spec2.transform)) {
        result += '\ntransform: ' + JSON.stringify(spec1.transform) + ' != ' + JSON.stringify(spec2.transform);
      }
      if (!_isEqualArray(spec1.origin, spec2.origin)) {
        result += '\norigin: ' + JSON.stringify(spec1.origin) + ' != ' + JSON.stringify(spec2.origin);
      }
      if (!_isEqualArray(spec1.align, spec2.align)) {
        result += '\nalign: ' + JSON.stringify(spec1.align) + ' != ' + JSON.stringify(spec2.align);
      }
      return result;
    };
    LayoutUtility.error = function(message) {
      console.log('ERROR: ' + message);
      throw message;
    };
    LayoutUtility.warning = function(message) {
      console.log('WARNING: ' + message);
    };
    LayoutUtility.log = function(args) {
      var message = '';
      for (var i = 0; i < arguments.length; i++) {
        var arg = arguments[i];
        if ((arg instanceof Object) || (arg instanceof Array)) {
          message += JSON.stringify(arg);
        } else {
          message += arg;
        }
      }
      console.log(message);
    };
    LayoutUtility.combineOptions = function(options1, options2, forceClone) {
      if (options1 && !options2 && !forceClone) {
        return options1;
      } else if (!options1 && options2 && !forceClone) {
        return options2;
      }
      var options = Utility.clone(options1 || {});
      if (options2) {
        for (var key in options2) {
          options[key] = options2[key];
        }
      }
      return options;
    };
    LayoutUtility.registerHelper = function(name, Helper) {
      if (!Helper.prototype.parse) {
        LayoutUtility.error('The layout-helper for name "' + name + '" is required to support the "parse" method');
      }
      if (this.registeredHelpers[name] !== undefined) {
        LayoutUtility.warning('A layout-helper with the name "' + name + '" is already registered and will be overwritten');
      }
      this.registeredHelpers[name] = Helper;
    };
    LayoutUtility.unregisterHelper = function(name) {
      delete this.registeredHelpers[name];
    };
    LayoutUtility.getRegisteredHelper = function(name) {
      return this.registeredHelpers[name];
    };
    module.exports = LayoutUtility;
  }).call(__exports, __require, __exports, __module);
});


})();
(function() {
function define(){};  define.amd = {};
System.register("github:IjzerenHein/famous-flex@0.2.0/src/LayoutContext", [], false, function(__require, __exports, __module) {
  return (function(require, exports, module) {
    function LayoutContext(methods) {
      for (var n in methods) {
        this[n] = methods[n];
      }
    }
    LayoutContext.prototype.size = undefined;
    LayoutContext.prototype.direction = undefined;
    LayoutContext.prototype.scrollOffset = undefined;
    LayoutContext.prototype.scrollStart = undefined;
    LayoutContext.prototype.scrollEnd = undefined;
    LayoutContext.prototype.next = function() {};
    LayoutContext.prototype.prev = function() {};
    LayoutContext.prototype.get = function(node) {};
    LayoutContext.prototype.set = function(node, set) {};
    LayoutContext.prototype.resolveSize = function(node) {};
    module.exports = LayoutContext;
  }).call(__exports, __require, __exports, __module);
});


})();
(function() {
function define(){};  define.amd = {};
System.register("github:IjzerenHein/famous-flex@0.2.0/src/LayoutNode", ["npm:famous@0.3.5/core/Transform", "github:IjzerenHein/famous-flex@0.2.0/src/LayoutUtility"], false, function(__require, __exports, __module) {
  return (function(require, exports, module) {
    var Transform = require("npm:famous@0.3.5/core/Transform");
    var LayoutUtility = require("github:IjzerenHein/famous-flex@0.2.0/src/LayoutUtility");
    function LayoutNode(renderNode, spec) {
      this.renderNode = renderNode;
      this._spec = spec ? LayoutUtility.cloneSpec(spec) : {};
      this._spec.renderNode = renderNode;
      this._specModified = true;
      this._invalidated = false;
      this._removing = false;
    }
    LayoutNode.prototype.setOptions = function(options) {};
    LayoutNode.prototype.destroy = function() {
      this.renderNode = undefined;
      this._spec.renderNode = undefined;
      this._viewSequence = undefined;
    };
    LayoutNode.prototype.reset = function() {
      this._invalidated = false;
      this.trueSizeRequested = false;
    };
    LayoutNode.prototype.setSpec = function(spec) {
      this._specModified = true;
      if (spec.align) {
        if (!spec.align) {
          this._spec.align = [0, 0];
        }
        this._spec.align[0] = spec.align[0];
        this._spec.align[1] = spec.align[1];
      } else {
        this._spec.align = undefined;
      }
      if (spec.origin) {
        if (!spec.origin) {
          this._spec.origin = [0, 0];
        }
        this._spec.origin[0] = spec.origin[0];
        this._spec.origin[1] = spec.origin[1];
      } else {
        this._spec.origin = undefined;
      }
      if (spec.size) {
        if (!spec.size) {
          this._spec.size = [0, 0];
        }
        this._spec.size[0] = spec.size[0];
        this._spec.size[1] = spec.size[1];
      } else {
        this._spec.size = undefined;
      }
      if (spec.transform) {
        if (!spec.transform) {
          this._spec.transform = spec.transform.slice(0);
        } else {
          for (var i = 0; i < 16; i++) {
            this._spec.transform[0] = spec.transform[0];
          }
        }
      } else {
        this._spec.transform = undefined;
      }
      this._spec.opacity = spec.opacity;
    };
    LayoutNode.prototype.set = function(set, size) {
      this._invalidated = true;
      this._specModified = true;
      this._removing = false;
      var spec = this._spec;
      spec.opacity = set.opacity;
      if (set.size) {
        if (!spec.size) {
          spec.size = [0, 0];
        }
        spec.size[0] = set.size[0];
        spec.size[1] = set.size[1];
      } else {
        spec.size = undefined;
      }
      if (set.origin) {
        if (!spec.origin) {
          spec.origin = [0, 0];
        }
        spec.origin[0] = set.origin[0];
        spec.origin[1] = set.origin[1];
      } else {
        spec.origin = undefined;
      }
      if (set.align) {
        if (!spec.align) {
          spec.align = [0, 0];
        }
        spec.align[0] = set.align[0];
        spec.align[1] = set.align[1];
      } else {
        spec.align = undefined;
      }
      if (set.skew || set.rotate || set.scale) {
        this._spec.transform = Transform.build({
          translate: set.translate || [0, 0, 0],
          skew: set.skew || [0, 0, 0],
          scale: set.scale || [1, 1, 1],
          rotate: set.rotate || [0, 0, 0]
        });
      } else if (set.translate) {
        this._spec.transform = Transform.translate(set.translate[0], set.translate[1], set.translate[2]);
      } else {
        this._spec.transform = undefined;
      }
      this.scrollLength = set.scrollLength;
    };
    LayoutNode.prototype.getSpec = function() {
      this._specModified = false;
      this._spec.removed = !this._invalidated;
      return this._spec;
    };
    LayoutNode.prototype.remove = function(removeSpec) {
      this._removing = true;
    };
    module.exports = LayoutNode;
  }).call(__exports, __require, __exports, __module);
});


})();
(function() {
function define(){};  define.amd = {};
System.register("github:IjzerenHein/famous-flex@0.2.0/src/FlowLayoutNode", ["npm:famous@0.3.5/core/OptionsManager", "npm:famous@0.3.5/core/Transform", "npm:famous@0.3.5/math/Vector", "npm:famous@0.3.5/physics/bodies/Particle", "npm:famous@0.3.5/physics/forces/Spring", "npm:famous@0.3.5/physics/PhysicsEngine", "github:IjzerenHein/famous-flex@0.2.0/src/LayoutNode", "npm:famous@0.3.5/transitions/Transitionable"], false, function(__require, __exports, __module) {
  return (function(require, exports, module) {
    var OptionsManager = require("npm:famous@0.3.5/core/OptionsManager");
    var Transform = require("npm:famous@0.3.5/core/Transform");
    var Vector = require("npm:famous@0.3.5/math/Vector");
    var Particle = require("npm:famous@0.3.5/physics/bodies/Particle");
    var Spring = require("npm:famous@0.3.5/physics/forces/Spring");
    var PhysicsEngine = require("npm:famous@0.3.5/physics/PhysicsEngine");
    var LayoutNode = require("github:IjzerenHein/famous-flex@0.2.0/src/LayoutNode");
    var Transitionable = require("npm:famous@0.3.5/transitions/Transitionable");
    function FlowLayoutNode(renderNode, spec) {
      LayoutNode.apply(this, arguments);
      if (!this.options) {
        this.options = Object.create(this.constructor.DEFAULT_OPTIONS);
        this._optionsManager = new OptionsManager(this.options);
      }
      if (!this._pe) {
        this._pe = new PhysicsEngine();
        this._pe.sleep();
      }
      if (!this._properties) {
        this._properties = {};
      } else {
        for (var propName in this._properties) {
          this._properties[propName].init = false;
        }
      }
      if (!this._lockTransitionable) {
        this._lockTransitionable = new Transitionable(1);
      } else {
        this._lockTransitionable.halt();
        this._lockTransitionable.reset(1);
      }
      this._specModified = true;
      this._initial = true;
      if (spec) {
        this.setSpec(spec);
      }
    }
    FlowLayoutNode.prototype = Object.create(LayoutNode.prototype);
    FlowLayoutNode.prototype.constructor = FlowLayoutNode;
    FlowLayoutNode.DEFAULT_OPTIONS = {
      spring: {
        dampingRatio: 0.8,
        period: 300
      },
      particleRounding: 0.001
    };
    var DEFAULT = {
      opacity: 1,
      opacity2D: [1, 0],
      size: [0, 0],
      origin: [0, 0],
      align: [0, 0],
      scale: [1, 1, 1],
      translate: [0, 0, 0],
      rotate: [0, 0, 0],
      skew: [0, 0, 0]
    };
    FlowLayoutNode.prototype.setOptions = function(options) {
      this._optionsManager.setOptions(options);
      var wasSleeping = this._pe.isSleeping();
      for (var propName in this._properties) {
        var prop = this._properties[propName];
        if (prop.force) {
          prop.force.setOptions(prop.force);
        }
      }
      if (wasSleeping) {
        this._pe.sleep();
      }
      return this;
    };
    FlowLayoutNode.prototype.setSpec = function(spec) {
      var set;
      if (spec.transform) {
        set = Transform.interpret(spec.transform);
      }
      if (!set) {
        set = {};
      }
      set.opacity = spec.opacity;
      set.size = spec.size;
      set.align = spec.align;
      set.origin = spec.origin;
      var oldRemoving = this._removing;
      var oldInvalidated = this._invalidated;
      this.set(set);
      this._removing = oldRemoving;
      this._invalidated = oldInvalidated;
    };
    FlowLayoutNode.prototype.reset = function() {
      if (this._invalidated) {
        for (var propName in this._properties) {
          this._properties[propName].invalidated = false;
        }
        this._invalidated = false;
      }
      this.trueSizeRequested = false;
      this.usesTrueSize = false;
    };
    FlowLayoutNode.prototype.remove = function(removeSpec) {
      this._removing = true;
      if (removeSpec) {
        this.setSpec(removeSpec);
      } else {
        this._pe.sleep();
        this._specModified = false;
      }
      this._invalidated = false;
    };
    FlowLayoutNode.prototype.releaseLock = function(duration) {
      this._lockTransitionable.halt();
      this._lockTransitionable.reset(0);
      this._lockTransitionable.set(1, {duration: duration || this.options.spring.period || 1000});
    };
    function _getRoundedValue3D(prop, def, precision, lockValue) {
      if (!prop || !prop.init) {
        return def;
      }
      return [Math.round((prop.curState.x + ((prop.endState.x - prop.curState.x) * lockValue)) / precision) * precision, Math.round((prop.curState.y + ((prop.endState.y - prop.curState.y) * lockValue)) / precision) * precision, Math.round((prop.curState.z + ((prop.endState.z - prop.curState.z) * lockValue)) / precision) * precision];
    }
    FlowLayoutNode.prototype.getSpec = function() {
      var endStateReached = this._pe.isSleeping();
      if (!this._specModified && endStateReached) {
        this._spec.removed = !this._invalidated;
        return this._spec;
      }
      this._initial = false;
      this._specModified = !endStateReached;
      this._spec.removed = false;
      if (!endStateReached) {
        this._pe.step();
      }
      var spec = this._spec;
      var precision = this.options.particleRounding;
      var lockValue = this._lockTransitionable.get();
      var prop = this._properties.opacity;
      if (prop && prop.init) {
        spec.opacity = Math.round(Math.max(0, Math.min(1, prop.curState.x)) / precision) * precision;
      } else {
        spec.opacity = undefined;
      }
      prop = this._properties.size;
      if (prop && prop.init) {
        spec.size = spec.size || [0, 0];
        spec.size[0] = Math.round((prop.curState.x + ((prop.endState.x - prop.curState.x) * lockValue)) / 0.1) * 0.1;
        spec.size[1] = Math.round((prop.curState.y + ((prop.endState.y - prop.curState.y) * lockValue)) / 0.1) * 0.1;
      } else {
        spec.size = undefined;
      }
      prop = this._properties.align;
      if (prop && prop.init) {
        spec.align = spec.align || [0, 0];
        spec.align[0] = Math.round((prop.curState.x + ((prop.endState.x - prop.curState.x) * lockValue)) / 0.1) * 0.1;
        spec.align[1] = Math.round((prop.curState.y + ((prop.endState.y - prop.curState.y) * lockValue)) / 0.1) * 0.1;
      } else {
        spec.align = undefined;
      }
      prop = this._properties.origin;
      if (prop && prop.init) {
        spec.origin = spec.origin || [0, 0];
        spec.origin[0] = Math.round((prop.curState.x + ((prop.endState.x - prop.curState.x) * lockValue)) / 0.1) * 0.1;
        spec.origin[1] = Math.round((prop.curState.y + ((prop.endState.y - prop.curState.y) * lockValue)) / 0.1) * 0.1;
      } else {
        spec.origin = undefined;
      }
      var translate = this._properties.translate;
      var translateX;
      var translateY;
      var translateZ;
      if (translate && translate.init) {
        translateX = Math.round((translate.curState.x + ((translate.endState.x - translate.curState.x) * lockValue)) / precision) * precision;
        translateY = Math.round((translate.curState.y + ((translate.endState.y - translate.curState.y) * lockValue)) / precision) * precision;
        translateZ = Math.round((translate.curState.z + ((translate.endState.z - translate.curState.z) * lockValue)) / precision) * precision;
      } else {
        translateX = 0;
        translateY = 0;
        translateZ = 0;
      }
      var scale = this._properties.scale;
      var skew = this._properties.skew;
      var rotate = this._properties.rotate;
      if (scale || skew || rotate) {
        spec.transform = Transform.build({
          translate: [translateX, translateY, translateZ],
          skew: _getRoundedValue3D.call(this, skew, DEFAULT.skew, this.options.particleRounding, lockValue),
          scale: _getRoundedValue3D.call(this, scale, DEFAULT.scale, this.options.particleRounding, lockValue),
          rotate: _getRoundedValue3D.call(this, rotate, DEFAULT.rotate, this.options.particleRounding, lockValue)
        });
      } else if (translate) {
        if (!spec.transform) {
          spec.transform = Transform.translate(translateX, translateY, translateZ);
        } else {
          spec.transform[12] = translateX;
          spec.transform[13] = translateY;
          spec.transform[14] = translateZ;
        }
      } else {
        spec.transform = undefined;
      }
      return this._spec;
    };
    function _setPropertyValue(prop, propName, endState, defaultValue, immediate, isTranslate) {
      prop = prop || this._properties[propName];
      if (prop && prop.init) {
        prop.invalidated = true;
        var value = defaultValue;
        if (endState !== undefined) {
          value = endState;
        } else if (this._removing) {
          value = prop.particle.getPosition();
        }
        prop.endState.x = value[0];
        prop.endState.y = (value.length > 1) ? value[1] : 0;
        prop.endState.z = (value.length > 2) ? value[2] : 0;
        if (immediate) {
          prop.curState.x = prop.endState.x;
          prop.curState.y = prop.endState.y;
          prop.curState.z = prop.endState.z;
          prop.velocity.x = 0;
          prop.velocity.y = 0;
          prop.velocity.z = 0;
        } else if ((prop.endState.x !== prop.curState.x) || (prop.endState.y !== prop.curState.y) || (prop.endState.z !== prop.curState.z)) {
          this._pe.wake();
        }
        return ;
      } else {
        var wasSleeping = this._pe.isSleeping();
        if (!prop) {
          prop = {
            particle: new Particle({position: (this._initial || immediate) ? endState : defaultValue}),
            endState: new Vector(endState)
          };
          prop.curState = prop.particle.position;
          prop.velocity = prop.particle.velocity;
          prop.force = new Spring(this.options.spring);
          prop.force.setOptions({anchor: prop.endState});
          this._pe.addBody(prop.particle);
          prop.forceId = this._pe.attach(prop.force, prop.particle);
          this._properties[propName] = prop;
        } else {
          prop.particle.setPosition((this._initial || immediate) ? endState : defaultValue);
          prop.endState.set(endState);
        }
        if (!this._initial && !immediate) {
          this._pe.wake();
        } else if (wasSleeping) {
          this._pe.sleep();
        }
        prop.init = true;
        prop.invalidated = true;
      }
    }
    function _getIfNE2D(a1, a2) {
      return ((a1[0] === a2[0]) && (a1[1] === a2[1])) ? undefined : a1;
    }
    function _getIfNE3D(a1, a2) {
      return ((a1[0] === a2[0]) && (a1[1] === a2[1]) && (a1[2] === a2[2])) ? undefined : a1;
    }
    FlowLayoutNode.prototype.set = function(set, defaultSize) {
      if (defaultSize) {
        this._removing = false;
      }
      this._invalidated = true;
      this.scrollLength = set.scrollLength;
      this._specModified = true;
      var prop = this._properties.opacity;
      var value = (set.opacity === DEFAULT.opacity) ? undefined : set.opacity;
      if ((value !== undefined) || (prop && prop.init)) {
        _setPropertyValue.call(this, prop, 'opacity', (value === undefined) ? undefined : [value, 0], DEFAULT.opacity2D);
      }
      prop = this._properties.align;
      value = set.align ? _getIfNE2D(set.align, DEFAULT.align) : undefined;
      if (value || (prop && prop.init)) {
        _setPropertyValue.call(this, prop, 'align', value, DEFAULT.align);
      }
      prop = this._properties.origin;
      value = set.origin ? _getIfNE2D(set.origin, DEFAULT.origin) : undefined;
      if (value || (prop && prop.init)) {
        _setPropertyValue.call(this, prop, 'origin', value, DEFAULT.origin);
      }
      prop = this._properties.size;
      value = set.size || defaultSize;
      if (value || (prop && prop.init)) {
        _setPropertyValue.call(this, prop, 'size', value, defaultSize, this.usesTrueSize);
      }
      prop = this._properties.translate;
      value = set.translate;
      if (value || (prop && prop.init)) {
        _setPropertyValue.call(this, prop, 'translate', value, DEFAULT.translate, undefined, true);
      }
      prop = this._properties.scale;
      value = set.scale ? _getIfNE3D(set.scale, DEFAULT.scale) : undefined;
      if (value || (prop && prop.init)) {
        _setPropertyValue.call(this, prop, 'scale', value, DEFAULT.scale);
      }
      prop = this._properties.rotate;
      value = set.rotate ? _getIfNE3D(set.rotate, DEFAULT.rotate) : undefined;
      if (value || (prop && prop.init)) {
        _setPropertyValue.call(this, prop, 'rotate', value, DEFAULT.rotate);
      }
      prop = this._properties.skew;
      value = set.skew ? _getIfNE3D(set.skew, DEFAULT.skew) : undefined;
      if (value || (prop && prop.init)) {
        _setPropertyValue.call(this, prop, 'skew', value, DEFAULT.skew);
      }
    };
    module.exports = FlowLayoutNode;
  }).call(__exports, __require, __exports, __module);
});


})();
(function() {
function define(){};  define.amd = {};
System.register("github:IjzerenHein/famous-flex@0.2.0/src/helpers/LayoutDockHelper", ["github:IjzerenHein/famous-flex@0.2.0/src/LayoutUtility"], false, function(__require, __exports, __module) {
  return (function(require, exports, module) {
    var LayoutUtility = require("github:IjzerenHein/famous-flex@0.2.0/src/LayoutUtility");
    function LayoutDockHelper(context, options) {
      var size = context.size;
      this._size = size;
      this._context = context;
      this._options = options;
      this._z = (options && options.translateZ) ? options.translateZ : 0;
      if (options && options.margins) {
        var margins = LayoutUtility.normalizeMargins(options.margins);
        this._left = margins[3];
        this._top = margins[0];
        this._right = size[0] - margins[1];
        this._bottom = size[1] - margins[2];
      } else {
        this._left = 0;
        this._top = 0;
        this._right = size[0];
        this._bottom = size[1];
      }
    }
    LayoutDockHelper.prototype.parse = function(data) {
      for (var i = 0; i < data.length; i++) {
        var rule = data[i];
        var value = (rule.length >= 3) ? rule[2] : undefined;
        if (rule[0] === 'top') {
          this.top(rule[1], value, (rule.length >= 4) ? rule[3] : undefined);
        } else if (rule[0] === 'left') {
          this.left(rule[1], value, (rule.length >= 4) ? rule[3] : undefined);
        } else if (rule[0] === 'right') {
          this.right(rule[1], value, (rule.length >= 4) ? rule[3] : undefined);
        } else if (rule[0] === 'bottom') {
          this.bottom(rule[1], value, (rule.length >= 4) ? rule[3] : undefined);
        } else if (rule[0] === 'fill') {
          this.fill(rule[1], (rule.length >= 3) ? rule[2] : undefined);
        } else if (rule[0] === 'margins') {
          this.margins(rule[1]);
        }
      }
    };
    LayoutDockHelper.prototype.top = function(node, height, z) {
      if (height instanceof Array) {
        height = height[1];
      }
      if (height === undefined) {
        var size = this._context.resolveSize(node, [this._right - this._left, this._bottom - this._top]);
        height = size[1];
      }
      this._context.set(node, {
        size: [this._right - this._left, height],
        origin: [0, 0],
        align: [0, 0],
        translate: [this._left, this._top, (z === undefined) ? this._z : z]
      });
      this._top += height;
      return this;
    };
    LayoutDockHelper.prototype.left = function(node, width, z) {
      if (width instanceof Array) {
        width = width[0];
      }
      if (width === undefined) {
        var size = this._context.resolveSize(node, [this._right - this._left, this._bottom - this._top]);
        width = size[0];
      }
      this._context.set(node, {
        size: [width, this._bottom - this._top],
        origin: [0, 0],
        align: [0, 0],
        translate: [this._left, this._top, (z === undefined) ? this._z : z]
      });
      this._left += width;
      return this;
    };
    LayoutDockHelper.prototype.bottom = function(node, height, z) {
      if (height instanceof Array) {
        height = height[1];
      }
      if (height === undefined) {
        var size = this._context.resolveSize(node, [this._right - this._left, this._bottom - this._top]);
        height = size[1];
      }
      this._context.set(node, {
        size: [this._right - this._left, height],
        origin: [0, 1],
        align: [0, 1],
        translate: [this._left, -(this._size[1] - this._bottom), (z === undefined) ? this._z : z]
      });
      this._bottom -= height;
      return this;
    };
    LayoutDockHelper.prototype.right = function(node, width, z) {
      if (width instanceof Array) {
        width = width[0];
      }
      if (node) {
        if (width === undefined) {
          var size = this._context.resolveSize(node, [this._right - this._left, this._bottom - this._top]);
          width = size[0];
        }
        this._context.set(node, {
          size: [width, this._bottom - this._top],
          origin: [1, 0],
          align: [1, 0],
          translate: [-(this._size[0] - this._right), this._top, (z === undefined) ? this._z : z]
        });
      }
      if (width) {
        this._right -= width;
      }
      return this;
    };
    LayoutDockHelper.prototype.fill = function(node, z) {
      this._context.set(node, {
        size: [this._right - this._left, this._bottom - this._top],
        translate: [this._left, this._top, (z === undefined) ? this._z : z]
      });
      return this;
    };
    LayoutDockHelper.prototype.margins = function(margins) {
      margins = LayoutUtility.normalizeMargins(margins);
      this._left += margins[3];
      this._top += margins[0];
      this._right -= margins[1];
      this._bottom -= margins[2];
      return this;
    };
    LayoutUtility.registerHelper('dock', LayoutDockHelper);
    module.exports = LayoutDockHelper;
  }).call(__exports, __require, __exports, __module);
});


})();
(function() {
function define(){};  define.amd = {};
System.register("github:IjzerenHein/famous-flex@0.2.0/src/ScrollController", ["github:IjzerenHein/famous-flex@0.2.0/src/LayoutUtility", "github:IjzerenHein/famous-flex@0.2.0/src/LayoutController", "github:IjzerenHein/famous-flex@0.2.0/src/LayoutNode", "github:IjzerenHein/famous-flex@0.2.0/src/FlowLayoutNode", "github:IjzerenHein/famous-flex@0.2.0/src/LayoutNodeManager", "npm:famous@0.3.5/surfaces/ContainerSurface", "npm:famous@0.3.5/core/Transform", "npm:famous@0.3.5/core/EventHandler", "npm:famous@0.3.5/core/Group", "npm:famous@0.3.5/math/Vector", "npm:famous@0.3.5/physics/PhysicsEngine", "npm:famous@0.3.5/physics/bodies/Particle", "npm:famous@0.3.5/physics/forces/Drag", "npm:famous@0.3.5/physics/forces/Spring", "npm:famous@0.3.5/inputs/ScrollSync", "npm:famous@0.3.5/core/ViewSequence"], false, function(__require, __exports, __module) {
  return (function(require, exports, module) {
    var LayoutUtility = require("github:IjzerenHein/famous-flex@0.2.0/src/LayoutUtility");
    var LayoutController = require("github:IjzerenHein/famous-flex@0.2.0/src/LayoutController");
    var LayoutNode = require("github:IjzerenHein/famous-flex@0.2.0/src/LayoutNode");
    var FlowLayoutNode = require("github:IjzerenHein/famous-flex@0.2.0/src/FlowLayoutNode");
    var LayoutNodeManager = require("github:IjzerenHein/famous-flex@0.2.0/src/LayoutNodeManager");
    var ContainerSurface = require("npm:famous@0.3.5/surfaces/ContainerSurface");
    var Transform = require("npm:famous@0.3.5/core/Transform");
    var EventHandler = require("npm:famous@0.3.5/core/EventHandler");
    var Group = require("npm:famous@0.3.5/core/Group");
    var Vector = require("npm:famous@0.3.5/math/Vector");
    var PhysicsEngine = require("npm:famous@0.3.5/physics/PhysicsEngine");
    var Particle = require("npm:famous@0.3.5/physics/bodies/Particle");
    var Drag = require("npm:famous@0.3.5/physics/forces/Drag");
    var Spring = require("npm:famous@0.3.5/physics/forces/Spring");
    var ScrollSync = require("npm:famous@0.3.5/inputs/ScrollSync");
    var ViewSequence = require("npm:famous@0.3.5/core/ViewSequence");
    var Bounds = {
      NONE: 0,
      PREV: 1,
      NEXT: 2,
      BOTH: 3
    };
    var SpringSource = {
      NONE: 'none',
      NEXTBOUNDS: 'next-bounds',
      PREVBOUNDS: 'prev-bounds',
      MINSIZE: 'minimal-size',
      GOTOSEQUENCE: 'goto-sequence',
      ENSUREVISIBLE: 'ensure-visible',
      GOTOPREVDIRECTION: 'goto-prev-direction',
      GOTONEXTDIRECTION: 'goto-next-direction'
    };
    var PaginationMode = {
      PAGE: 0,
      SCROLL: 1
    };
    function ScrollController(options) {
      options = LayoutUtility.combineOptions(ScrollController.DEFAULT_OPTIONS, options);
      var layoutManager = new LayoutNodeManager(options.flow ? FlowLayoutNode : LayoutNode, _initLayoutNode.bind(this));
      LayoutController.call(this, options, layoutManager);
      this._scroll = {
        activeTouches: [],
        pe: new PhysicsEngine(),
        particle: new Particle(this.options.scrollParticle),
        dragForce: new Drag(this.options.scrollDrag),
        frictionForce: new Drag(this.options.scrollFriction),
        springValue: undefined,
        springForce: new Spring(this.options.scrollSpring),
        springEndState: new Vector([0, 0, 0]),
        groupStart: 0,
        groupTranslate: [0, 0, 0],
        scrollDelta: 0,
        normalizedScrollDelta: 0,
        scrollForce: 0,
        scrollForceCount: 0,
        unnormalizedScrollOffset: 0,
        isScrolling: false
      };
      this._debug = {
        layoutCount: 0,
        commitCount: 0
      };
      this.group = new Group();
      this.group.add({render: _innerRender.bind(this)});
      this._scroll.pe.addBody(this._scroll.particle);
      if (!this.options.scrollDrag.disabled) {
        this._scroll.dragForceId = this._scroll.pe.attach(this._scroll.dragForce, this._scroll.particle);
      }
      if (!this.options.scrollFriction.disabled) {
        this._scroll.frictionForceId = this._scroll.pe.attach(this._scroll.frictionForce, this._scroll.particle);
      }
      this._scroll.springForce.setOptions({anchor: this._scroll.springEndState});
      this._eventInput.on('touchstart', _touchStart.bind(this));
      this._eventInput.on('touchmove', _touchMove.bind(this));
      this._eventInput.on('touchend', _touchEnd.bind(this));
      this._eventInput.on('touchcancel', _touchEnd.bind(this));
      this._eventInput.on('mousedown', _mouseDown.bind(this));
      this._eventInput.on('mouseup', _mouseUp.bind(this));
      this._eventInput.on('mousemove', _mouseMove.bind(this));
      this._scrollSync = new ScrollSync(this.options.scrollSync);
      this._eventInput.pipe(this._scrollSync);
      this._scrollSync.on('update', _scrollUpdate.bind(this));
      if (this.options.useContainer) {
        this.container = new ContainerSurface(this.options.container);
        this.container.add({render: function() {
            return this.id;
          }.bind(this)});
        if (!this.options.autoPipeEvents) {
          this.subscribe(this.container);
          EventHandler.setInputHandler(this.container, this);
          EventHandler.setOutputHandler(this.container, this);
        }
      }
    }
    ScrollController.prototype = Object.create(LayoutController.prototype);
    ScrollController.prototype.constructor = ScrollController;
    ScrollController.Bounds = Bounds;
    ScrollController.PaginationMode = PaginationMode;
    ScrollController.DEFAULT_OPTIONS = {
      flow: false,
      useContainer: false,
      container: {properties: {overflow: 'hidden'}},
      visibleItemThresshold: 0.5,
      scrollParticle: {},
      scrollDrag: {
        forceFunction: Drag.FORCE_FUNCTIONS.QUADRATIC,
        strength: 0.001,
        disabled: true
      },
      scrollFriction: {
        forceFunction: Drag.FORCE_FUNCTIONS.LINEAR,
        strength: 0.0025,
        disabled: false
      },
      scrollSpring: {
        dampingRatio: 1.0,
        period: 350
      },
      scrollSync: {scale: 0.2},
      overscroll: true,
      paginated: false,
      paginationMode: PaginationMode.PAGE,
      paginationEnergyThresshold: 0.01,
      alignment: 0,
      touchMoveDirectionThresshold: undefined,
      touchMoveNoVelocityDuration: 100,
      mouseMove: false,
      enabled: true,
      layoutAll: false,
      alwaysLayout: false,
      extraBoundsSpace: [100, 100],
      debug: false
    };
    ScrollController.prototype.setOptions = function(options) {
      LayoutController.prototype.setOptions.call(this, options);
      if (this._scroll) {
        if (options.scrollSpring) {
          this._scroll.springForce.setOptions(options.scrollSpring);
        }
        if (options.scrollDrag) {
          this._scroll.dragForce.setOptions(options.scrollDrag);
        }
      }
      if (options.scrollSync && this._scrollSync) {
        this._scrollSync.setOptions(options.scrollSync);
      }
      return this;
    };
    function _initLayoutNode(node, spec) {
      if (!spec && this.options.insertSpec) {
        node.setSpec(this.options.insertSpec);
      }
    }
    function _updateSpring() {
      var springValue = this._scroll.scrollForceCount ? undefined : this._scroll.springPosition;
      if (this._scroll.springValue !== springValue) {
        this._scroll.springValue = springValue;
        if (springValue === undefined) {
          if (this._scroll.springForceId !== undefined) {
            this._scroll.pe.detach(this._scroll.springForceId);
            this._scroll.springForceId = undefined;
          }
        } else {
          if (this._scroll.springForceId === undefined) {
            this._scroll.springForceId = this._scroll.pe.attach(this._scroll.springForce, this._scroll.particle);
          }
          this._scroll.springEndState.set1D(springValue);
          this._scroll.pe.wake();
        }
      }
    }
    function _mouseDown(event) {
      if (!this.options.mouseMove) {
        return ;
      }
      if (this._scroll.mouseMove) {
        this.releaseScrollForce(this._scroll.mouseMove.delta);
      }
      var current = [event.clientX, event.clientY];
      var time = Date.now();
      this._scroll.mouseMove = {
        delta: 0,
        start: current,
        current: current,
        prev: current,
        time: time,
        prevTime: time
      };
      this.applyScrollForce(this._scroll.mouseMove.delta);
    }
    function _mouseMove(event) {
      if (!this._scroll.mouseMove || !this.options.enabled) {
        return ;
      }
      var moveDirection = Math.atan2(Math.abs(event.clientY - this._scroll.mouseMove.prev[1]), Math.abs(event.clientX - this._scroll.mouseMove.prev[0])) / (Math.PI / 2.0);
      var directionDiff = Math.abs(this._direction - moveDirection);
      if ((this.options.touchMoveDirectionThresshold === undefined) || (directionDiff <= this.options.touchMoveDirectionThresshold)) {
        this._scroll.mouseMove.prev = this._scroll.mouseMove.current;
        this._scroll.mouseMove.current = [event.clientX, event.clientY];
        this._scroll.mouseMove.prevTime = this._scroll.mouseMove.time;
        this._scroll.mouseMove.direction = moveDirection;
        this._scroll.mouseMove.time = Date.now();
      }
      var delta = this._scroll.mouseMove.current[this._direction] - this._scroll.mouseMove.start[this._direction];
      this.updateScrollForce(this._scroll.mouseMove.delta, delta);
      this._scroll.mouseMove.delta = delta;
    }
    function _mouseUp(event) {
      if (!this._scroll.mouseMove) {
        return ;
      }
      var velocity = 0;
      var diffTime = this._scroll.mouseMove.time - this._scroll.mouseMove.prevTime;
      if ((diffTime > 0) && ((Date.now() - this._scroll.mouseMove.time) <= this.options.touchMoveNoVelocityDuration)) {
        var diffOffset = this._scroll.mouseMove.current[this._direction] - this._scroll.mouseMove.prev[this._direction];
        velocity = diffOffset / diffTime;
      }
      this.releaseScrollForce(this._scroll.mouseMove.delta, velocity);
      this._scroll.mouseMove = undefined;
    }
    function _touchStart(event) {
      if (!this._touchEndEventListener) {
        this._touchEndEventListener = function(event2) {
          event2.target.removeEventListener('touchend', this._touchEndEventListener);
          _touchEnd.call(this, event2);
        }.bind(this);
      }
      var oldTouchesCount = this._scroll.activeTouches.length;
      var i = 0;
      var j;
      var touchFound;
      while (i < this._scroll.activeTouches.length) {
        var activeTouch = this._scroll.activeTouches[i];
        touchFound = false;
        for (j = 0; j < event.touches.length; j++) {
          var touch = event.touches[j];
          if (touch.identifier === activeTouch.id) {
            touchFound = true;
            break;
          }
        }
        if (!touchFound) {
          this._scroll.activeTouches.splice(i, 1);
        } else {
          i++;
        }
      }
      for (i = 0; i < event.touches.length; i++) {
        var changedTouch = event.touches[i];
        touchFound = false;
        for (j = 0; j < this._scroll.activeTouches.length; j++) {
          if (this._scroll.activeTouches[j].id === changedTouch.identifier) {
            touchFound = true;
            break;
          }
        }
        if (!touchFound) {
          var current = [changedTouch.clientX, changedTouch.clientY];
          var time = Date.now();
          this._scroll.activeTouches.push({
            id: changedTouch.identifier,
            start: current,
            current: current,
            prev: current,
            time: time,
            prevTime: time
          });
          changedTouch.target.addEventListener('touchend', this._touchEndEventListener);
        }
      }
      if (!oldTouchesCount && this._scroll.activeTouches.length) {
        this.applyScrollForce(0);
        this._scroll.touchDelta = 0;
      }
    }
    function _touchMove(event) {
      if (!this.options.enabled) {
        return ;
      }
      var primaryTouch;
      for (var i = 0; i < event.changedTouches.length; i++) {
        var changedTouch = event.changedTouches[i];
        for (var j = 0; j < this._scroll.activeTouches.length; j++) {
          var touch = this._scroll.activeTouches[j];
          if (touch.id === changedTouch.identifier) {
            var moveDirection = Math.atan2(Math.abs(changedTouch.clientY - touch.prev[1]), Math.abs(changedTouch.clientX - touch.prev[0])) / (Math.PI / 2.0);
            var directionDiff = Math.abs(this._direction - moveDirection);
            if ((this.options.touchMoveDirectionThresshold === undefined) || (directionDiff <= this.options.touchMoveDirectionThresshold)) {
              touch.prev = touch.current;
              touch.current = [changedTouch.clientX, changedTouch.clientY];
              touch.prevTime = touch.time;
              touch.direction = moveDirection;
              touch.time = Date.now();
              primaryTouch = (j === 0) ? touch : undefined;
            }
          }
        }
      }
      if (primaryTouch) {
        var delta = primaryTouch.current[this._direction] - primaryTouch.start[this._direction];
        this.updateScrollForce(this._scroll.touchDelta, delta);
        this._scroll.touchDelta = delta;
      }
    }
    function _touchEnd(event) {
      var primaryTouch = this._scroll.activeTouches.length ? this._scroll.activeTouches[0] : undefined;
      for (var i = 0; i < event.changedTouches.length; i++) {
        var changedTouch = event.changedTouches[i];
        for (var j = 0; j < this._scroll.activeTouches.length; j++) {
          var touch = this._scroll.activeTouches[j];
          if (touch.id === changedTouch.identifier) {
            this._scroll.activeTouches.splice(j, 1);
            if ((j === 0) && this._scroll.activeTouches.length) {
              var newPrimaryTouch = this._scroll.activeTouches[0];
              newPrimaryTouch.start[0] = newPrimaryTouch.current[0] - (touch.current[0] - touch.start[0]);
              newPrimaryTouch.start[1] = newPrimaryTouch.current[1] - (touch.current[1] - touch.start[1]);
            }
            break;
          }
        }
      }
      if (!primaryTouch || this._scroll.activeTouches.length) {
        return ;
      }
      var velocity = 0;
      var diffTime = primaryTouch.time - primaryTouch.prevTime;
      if ((diffTime > 0) && ((Date.now() - primaryTouch.time) <= this.options.touchMoveNoVelocityDuration)) {
        var diffOffset = primaryTouch.current[this._direction] - primaryTouch.prev[this._direction];
        velocity = diffOffset / diffTime;
      }
      var delta = this._scroll.touchDelta;
      this.releaseScrollForce(delta, velocity);
      this._scroll.touchDelta = 0;
    }
    function _scrollUpdate(event) {
      if (!this.options.enabled) {
        return ;
      }
      var offset = Array.isArray(event.delta) ? event.delta[this._direction] : event.delta;
      this.scroll(offset);
    }
    function _setParticle(position, velocity, phase) {
      if (position !== undefined) {
        this._scroll.particleValue = position;
        this._scroll.particle.setPosition1D(position);
      }
      if (velocity !== undefined) {
        var oldVelocity = this._scroll.particle.getVelocity1D();
        if (oldVelocity !== velocity) {
          this._scroll.particle.setVelocity1D(velocity);
        }
      }
    }
    function _calcScrollOffset(normalize, refreshParticle) {
      if (refreshParticle || (this._scroll.particleValue === undefined)) {
        this._scroll.particleValue = this._scroll.particle.getPosition1D();
        this._scroll.particleValue = Math.round(this._scroll.particleValue * 1000) / 1000;
      }
      var scrollOffset = this._scroll.particleValue;
      if (this._scroll.scrollDelta || this._scroll.normalizedScrollDelta) {
        scrollOffset += this._scroll.scrollDelta + this._scroll.normalizedScrollDelta;
        if (((this._scroll.boundsReached & Bounds.PREV) && (scrollOffset > this._scroll.springPosition)) || ((this._scroll.boundsReached & Bounds.NEXT) && (scrollOffset < this._scroll.springPosition)) || (this._scroll.boundsReached === Bounds.BOTH)) {
          scrollOffset = this._scroll.springPosition;
        }
        if (normalize) {
          if (!this._scroll.scrollDelta) {
            this._scroll.normalizedScrollDelta = 0;
            _setParticle.call(this, scrollOffset, undefined, '_calcScrollOffset');
          }
          this._scroll.normalizedScrollDelta += this._scroll.scrollDelta;
          this._scroll.scrollDelta = 0;
        }
      }
      if (this._scroll.scrollForceCount && this._scroll.scrollForce) {
        if (this._scroll.springPosition !== undefined) {
          scrollOffset = (scrollOffset + this._scroll.scrollForce + this._scroll.springPosition) / 2.0;
        } else {
          scrollOffset += this._scroll.scrollForce;
        }
      }
      if (!this.options.overscroll) {
        if ((this._scroll.boundsReached === Bounds.BOTH) || ((this._scroll.boundsReached === Bounds.PREV) && (scrollOffset > this._scroll.springPosition)) || ((this._scroll.boundsReached === Bounds.NEXT) && (scrollOffset < this._scroll.springPosition))) {
          scrollOffset = this._scroll.springPosition;
        }
      }
      return scrollOffset;
    }
    ScrollController.prototype._calcScrollHeight = function(next, lastNodeOnly) {
      var calcedHeight = 0;
      var node = this._nodes.getStartEnumNode(next);
      while (node) {
        if (node._invalidated) {
          if (node.trueSizeRequested) {
            calcedHeight = undefined;
            break;
          }
          if (node.scrollLength !== undefined) {
            calcedHeight = lastNodeOnly ? node.scrollLength : (calcedHeight + node.scrollLength);
            if (!next && lastNodeOnly) {
              break;
            }
          }
        }
        node = next ? node._next : node._prev;
      }
      return calcedHeight;
    };
    function _calcBounds(size, scrollOffset) {
      var prevHeight = this._calcScrollHeight(false);
      var nextHeight = this._calcScrollHeight(true);
      var enforeMinSize = this._layout.capabilities && this._layout.capabilities.sequentialScrollingOptimized;
      if ((prevHeight === undefined) || (nextHeight === undefined)) {
        this._scroll.boundsReached = Bounds.NONE;
        this._scroll.springPosition = undefined;
        this._scroll.springSource = SpringSource.NONE;
        return ;
      }
      var totalHeight;
      if (enforeMinSize) {
        if ((nextHeight !== undefined) && (prevHeight !== undefined)) {
          totalHeight = prevHeight + nextHeight;
        }
        if ((totalHeight !== undefined) && (totalHeight <= size[this._direction])) {
          this._scroll.boundsReached = Bounds.BOTH;
          this._scroll.springPosition = this.options.alignment ? -nextHeight : prevHeight;
          this._scroll.springSource = SpringSource.MINSIZE;
          return ;
        }
      }
      if (this.options.alignment) {
        if (enforeMinSize) {
          if ((nextHeight !== undefined) && ((scrollOffset + nextHeight) <= 0)) {
            this._scroll.boundsReached = Bounds.NEXT;
            this._scroll.springPosition = -nextHeight;
            this._scroll.springSource = SpringSource.NEXTBOUNDS;
            return ;
          }
        } else {
          var firstPrevItemHeight = this._calcScrollHeight(false, true);
          if ((nextHeight !== undefined) && firstPrevItemHeight && ((scrollOffset + nextHeight + size[this._direction]) <= firstPrevItemHeight)) {
            this._scroll.boundsReached = Bounds.NEXT;
            this._scroll.springPosition = nextHeight - (size[this._direction] - firstPrevItemHeight);
            this._scroll.springSource = SpringSource.NEXTBOUNDS;
            return ;
          }
        }
      } else {
        if ((prevHeight !== undefined) && ((scrollOffset - prevHeight) >= 0)) {
          this._scroll.boundsReached = Bounds.PREV;
          this._scroll.springPosition = prevHeight;
          this._scroll.springSource = SpringSource.PREVBOUNDS;
          return ;
        }
      }
      if (this.options.alignment) {
        if ((prevHeight !== undefined) && ((scrollOffset - prevHeight) >= -size[this._direction])) {
          this._scroll.boundsReached = Bounds.PREV;
          this._scroll.springPosition = -size[this._direction] + prevHeight;
          this._scroll.springSource = SpringSource.PREVBOUNDS;
          return ;
        }
      } else {
        var nextBounds = enforeMinSize ? size[this._direction] : this._calcScrollHeight(true, true);
        if ((nextHeight !== undefined) && ((scrollOffset + nextHeight) <= nextBounds)) {
          this._scroll.boundsReached = Bounds.NEXT;
          this._scroll.springPosition = nextBounds - nextHeight;
          this._scroll.springSource = SpringSource.NEXTBOUNDS;
          return ;
        }
      }
      this._scroll.boundsReached = Bounds.NONE;
      this._scroll.springPosition = undefined;
      this._scroll.springSource = SpringSource.NONE;
    }
    function _calcScrollToOffset(size, scrollOffset) {
      var scrollToRenderNode = this._scroll.scrollToRenderNode || this._scroll.ensureVisibleRenderNode;
      if (!scrollToRenderNode) {
        return ;
      }
      if ((this._scroll.boundsReached === Bounds.BOTH) || (!this._scroll.scrollToDirection && (this._scroll.boundsReached === Bounds.PREV)) || (this._scroll.scrollToDirection && (this._scroll.boundsReached === Bounds.NEXT))) {
        return ;
      }
      var foundNode;
      var scrollToOffset = 0;
      var node = this._nodes.getStartEnumNode(true);
      var count = 0;
      while (node) {
        count++;
        if (!node._invalidated || (node.scrollLength === undefined)) {
          break;
        }
        if (this.options.alignment) {
          scrollToOffset -= node.scrollLength;
        }
        if (node.renderNode === scrollToRenderNode) {
          foundNode = node;
          break;
        }
        if (!this.options.alignment) {
          scrollToOffset -= node.scrollLength;
        }
        node = node._next;
      }
      if (!foundNode) {
        scrollToOffset = 0;
        node = this._nodes.getStartEnumNode(false);
        while (node) {
          if (!node._invalidated || (node.scrollLength === undefined)) {
            break;
          }
          if (!this.options.alignment) {
            scrollToOffset += node.scrollLength;
          }
          if (node.renderNode === scrollToRenderNode) {
            foundNode = node;
            break;
          }
          if (this.options.alignment) {
            scrollToOffset += node.scrollLength;
          }
          node = node._prev;
        }
      }
      if (foundNode) {
        if (this._scroll.ensureVisibleRenderNode) {
          if (this.options.alignment) {
            if ((scrollToOffset - foundNode.scrollLength) < 0) {
              this._scroll.springPosition = scrollToOffset;
              this._scroll.springSource = SpringSource.ENSUREVISIBLE;
            } else if (scrollToOffset > size[this._direction]) {
              this._scroll.springPosition = size[this._direction] - scrollToOffset;
              this._scroll.springSource = SpringSource.ENSUREVISIBLE;
            } else {
              if (!foundNode.trueSizeRequested) {
                this._scroll.ensureVisibleRenderNode = undefined;
              }
            }
          } else {
            scrollToOffset = -scrollToOffset;
            if (scrollToOffset < 0) {
              this._scroll.springPosition = scrollToOffset;
              this._scroll.springSource = SpringSource.ENSUREVISIBLE;
            } else if ((scrollToOffset + foundNode.scrollLength) > size[this._direction]) {
              this._scroll.springPosition = size[this._direction] - (scrollToOffset + foundNode.scrollLength);
              this._scroll.springSource = SpringSource.ENSUREVISIBLE;
            } else {
              if (!foundNode.trueSizeRequested) {
                this._scroll.ensureVisibleRenderNode = undefined;
              }
            }
          }
        } else {
          this._scroll.springPosition = scrollToOffset;
          this._scroll.springSource = SpringSource.GOTOSEQUENCE;
        }
        return ;
      }
      if (this._scroll.scrollToDirection) {
        this._scroll.springPosition = scrollOffset - size[this._direction];
        this._scroll.springSource = SpringSource.GOTONEXTDIRECTION;
      } else {
        this._scroll.springPosition = scrollOffset + size[this._direction];
        this._scroll.springSource = SpringSource.GOTOPREVDIRECTION;
      }
      if (this._viewSequence.cleanup) {
        var viewSequence = this._viewSequence;
        while (viewSequence.get() !== scrollToRenderNode) {
          viewSequence = this._scroll.scrollToDirection ? viewSequence.getNext(true) : viewSequence.getPrevious(true);
          if (!viewSequence) {
            break;
          }
        }
      }
    }
    function _snapToPage() {
      if (!this.options.paginated || this._scroll.scrollForceCount || (this._scroll.springPosition !== undefined)) {
        return ;
      }
      var item;
      switch (this.options.paginationMode) {
        case PaginationMode.SCROLL:
          if (!this.options.paginationEnergyThresshold || (Math.abs(this._scroll.particle.getEnergy()) <= this.options.paginationEnergyThresshold)) {
            item = this.options.alignment ? this.getLastVisibleItem() : this.getFirstVisibleItem();
            if (item && item.renderNode) {
              this.goToRenderNode(item.renderNode);
            }
          }
          break;
        case PaginationMode.PAGE:
          item = this.options.alignment ? this.getLastVisibleItem() : this.getFirstVisibleItem();
          if (item && item.renderNode) {
            this.goToRenderNode(item.renderNode);
          }
          break;
      }
    }
    function _normalizePrevViewSequence(scrollOffset) {
      var count = 0;
      var normalizedScrollOffset = scrollOffset;
      var normalizeNextPrev = false;
      var node = this._nodes.getStartEnumNode(false);
      while (node) {
        if (!node._invalidated || !node._viewSequence) {
          break;
        }
        if (normalizeNextPrev) {
          this._viewSequence = node._viewSequence;
          normalizedScrollOffset = scrollOffset;
          normalizeNextPrev = false;
        }
        if ((node.scrollLength === undefined) || node.trueSizeRequested || (scrollOffset < 0)) {
          break;
        }
        scrollOffset -= node.scrollLength;
        count++;
        if (node.scrollLength) {
          if (this.options.alignment) {
            normalizeNextPrev = (scrollOffset >= 0);
          } else {
            this._viewSequence = node._viewSequence;
            normalizedScrollOffset = scrollOffset;
          }
        }
        node = node._prev;
      }
      return normalizedScrollOffset;
    }
    function _normalizeNextViewSequence(scrollOffset) {
      var count = 0;
      var normalizedScrollOffset = scrollOffset;
      var node = this._nodes.getStartEnumNode(true);
      while (node) {
        if (!node._invalidated || (node.scrollLength === undefined) || node.trueSizeRequested || !node._viewSequence || ((scrollOffset > 0) && (!this.options.alignment || (node.scrollLength !== 0)))) {
          break;
        }
        if (this.options.alignment) {
          scrollOffset += node.scrollLength;
          count++;
        }
        if (node.scrollLength || this.options.alignment) {
          this._viewSequence = node._viewSequence;
          normalizedScrollOffset = scrollOffset;
        }
        if (!this.options.alignment) {
          scrollOffset += node.scrollLength;
          count++;
        }
        node = node._next;
      }
      return normalizedScrollOffset;
    }
    function _normalizeViewSequence(size, scrollOffset) {
      var caps = this._layout.capabilities;
      if (caps && caps.debug && (caps.debug.normalize !== undefined) && !caps.debug.normalize) {
        return scrollOffset;
      }
      if (this._scroll.scrollForceCount) {
        return scrollOffset;
      }
      var normalizedScrollOffset = scrollOffset;
      if (this.options.alignment && (scrollOffset < 0)) {
        normalizedScrollOffset = _normalizeNextViewSequence.call(this, scrollOffset);
      } else if (!this.options.alignment && (scrollOffset > 0)) {
        normalizedScrollOffset = _normalizePrevViewSequence.call(this, scrollOffset);
      }
      if (normalizedScrollOffset === scrollOffset) {
        if (this.options.alignment && (scrollOffset > 0)) {
          normalizedScrollOffset = _normalizePrevViewSequence.call(this, scrollOffset);
        } else if (!this.options.alignment && (scrollOffset < 0)) {
          normalizedScrollOffset = _normalizeNextViewSequence.call(this, scrollOffset);
        }
      }
      if (normalizedScrollOffset !== scrollOffset) {
        var delta = normalizedScrollOffset - scrollOffset;
        var particleValue = this._scroll.particle.getPosition1D();
        _setParticle.call(this, particleValue + delta, undefined, 'normalize');
        if (this._scroll.springPosition !== undefined) {
          this._scroll.springPosition += delta;
        }
        if (caps && caps.sequentialScrollingOptimized) {
          this._scroll.groupStart -= delta;
        }
      }
      return normalizedScrollOffset;
    }
    ScrollController.prototype.getVisibleItems = function() {
      var size = this._contextSizeCache;
      var scrollOffset = this.options.alignment ? (this._scroll.unnormalizedScrollOffset + size[this._direction]) : this._scroll.unnormalizedScrollOffset;
      var result = [];
      var node = this._nodes.getStartEnumNode(true);
      while (node) {
        if (!node._invalidated || (node.scrollLength === undefined) || (scrollOffset > size[this._direction])) {
          break;
        }
        scrollOffset += node.scrollLength;
        if ((scrollOffset >= 0) && node._viewSequence) {
          result.push({
            index: node._viewSequence.getIndex(),
            viewSequence: node._viewSequence,
            renderNode: node.renderNode,
            visiblePerc: node.scrollLength ? ((Math.min(scrollOffset, size[this._direction]) - Math.max(scrollOffset - node.scrollLength, 0)) / node.scrollLength) : 1,
            scrollOffset: scrollOffset - node.scrollLength,
            scrollLength: node.scrollLength,
            _node: node
          });
        }
        node = node._next;
      }
      scrollOffset = this.options.alignment ? (this._scroll.unnormalizedScrollOffset + size[this._direction]) : this._scroll.unnormalizedScrollOffset;
      node = this._nodes.getStartEnumNode(false);
      while (node) {
        if (!node._invalidated || (node.scrollLength === undefined) || (scrollOffset < 0)) {
          break;
        }
        scrollOffset -= node.scrollLength;
        if ((scrollOffset < size[this._direction]) && node._viewSequence) {
          result.unshift({
            index: node._viewSequence.getIndex(),
            viewSequence: node._viewSequence,
            renderNode: node.renderNode,
            visiblePerc: node.scrollLength ? ((Math.min(scrollOffset + node.scrollLength, size[this._direction]) - Math.max(scrollOffset, 0)) / node.scrollLength) : 1,
            scrollOffset: scrollOffset,
            scrollLength: node.scrollLength,
            _node: node
          });
        }
        node = node._prev;
      }
      return result;
    };
    ScrollController.prototype.getFirstVisibleItem = function(includeNode) {
      var size = this._contextSizeCache;
      var scrollOffset = this.options.alignment ? (this._scroll.unnormalizedScrollOffset + size[this._direction]) : this._scroll.unnormalizedScrollOffset;
      var node = this._nodes.getStartEnumNode(true);
      var nodeFoundVisiblePerc;
      var nodeFoundScrollOffset;
      var nodeFound;
      while (node) {
        if (!node._invalidated || (node.scrollLength === undefined) || (scrollOffset > size[this._direction])) {
          break;
        }
        scrollOffset += node.scrollLength;
        if ((scrollOffset >= 0) && node._viewSequence) {
          nodeFoundVisiblePerc = node.scrollLength ? ((Math.min(scrollOffset, size[this._direction]) - Math.max(scrollOffset - node.scrollLength, 0)) / node.scrollLength) : 1;
          nodeFoundScrollOffset = scrollOffset - node.scrollLength;
          if ((nodeFoundVisiblePerc >= this.options.visibleItemThresshold) || (nodeFoundScrollOffset >= 0)) {
            nodeFound = node;
            break;
          }
        }
        node = node._next;
      }
      scrollOffset = this.options.alignment ? (this._scroll.unnormalizedScrollOffset + size[this._direction]) : this._scroll.unnormalizedScrollOffset;
      node = this._nodes.getStartEnumNode(false);
      while (node) {
        if (!node._invalidated || (node.scrollLength === undefined) || (scrollOffset < 0)) {
          break;
        }
        scrollOffset -= node.scrollLength;
        if ((scrollOffset < size[this._direction]) && node._viewSequence) {
          var visiblePerc = node.scrollLength ? ((Math.min(scrollOffset + node.scrollLength, size[this._direction]) - Math.max(scrollOffset, 0)) / node.scrollLength) : 1;
          if ((visiblePerc >= this.options.visibleItemThresshold) || (scrollOffset >= 0)) {
            nodeFoundVisiblePerc = visiblePerc;
            nodeFoundScrollOffset = scrollOffset;
            nodeFound = node;
            break;
          }
        }
        node = node._prev;
      }
      return nodeFound ? {
        index: nodeFound._viewSequence.getIndex(),
        viewSequence: nodeFound._viewSequence,
        renderNode: nodeFound.renderNode,
        visiblePerc: nodeFoundVisiblePerc,
        scrollOffset: nodeFoundScrollOffset,
        scrollLength: nodeFound.scrollLength,
        _node: nodeFound
      } : undefined;
    };
    ScrollController.prototype.getLastVisibleItem = function() {
      var items = this.getVisibleItems();
      var size = this._contextSizeCache;
      for (var i = items.length - 1; i >= 0; i--) {
        var item = items[i];
        if ((item.visiblePerc >= this.options.visibleItemThresshold) || ((item.scrollOffset + item.scrollLength) <= size[this._direction])) {
          return item;
        }
      }
      return items.length ? items[items.length - 1] : undefined;
    };
    function _scrollToSequence(viewSequence, next) {
      this._scroll.scrollToSequence = viewSequence;
      this._scroll.scrollToRenderNode = viewSequence.get();
      this._scroll.ensureVisibleRenderNode = undefined;
      this._scroll.scrollToDirection = next;
      this._scroll.scrollDirty = true;
    }
    function _ensureVisibleSequence(viewSequence, next) {
      this._scroll.scrollToSequence = undefined;
      this._scroll.scrollToRenderNode = undefined;
      this._scroll.ensureVisibleRenderNode = viewSequence.get();
      this._scroll.scrollToDirection = next;
      this._scroll.scrollDirty = true;
    }
    function _goToPage(amount) {
      var viewSequence = this._scroll.scrollToSequence || this._viewSequence;
      if (!this._scroll.scrollToSequence) {
        var firstVisibleItem = this.getFirstVisibleItem();
        if (firstVisibleItem) {
          viewSequence = firstVisibleItem.viewSequence;
          if (((amount < 0) && (firstVisibleItem.scrollOffset < 0)) || ((amount > 0) && (firstVisibleItem.scrollOffset > 0))) {
            amount = 0;
          }
        }
      }
      if (!viewSequence) {
        return ;
      }
      for (var i = 0; i < Math.abs(amount); i++) {
        var nextViewSequence = (amount > 0) ? viewSequence.getNext() : viewSequence.getPrevious();
        if (nextViewSequence) {
          viewSequence = nextViewSequence;
        } else {
          break;
        }
      }
      _scrollToSequence.call(this, viewSequence, amount >= 0);
    }
    ScrollController.prototype.goToFirstPage = function() {
      if (!this._viewSequence) {
        return this;
      }
      if (this._viewSequence._ && this._viewSequence._.loop) {
        LayoutUtility.error('Unable to go to first item of looped ViewSequence');
        return this;
      }
      var viewSequence = this._viewSequence;
      while (viewSequence) {
        var prev = viewSequence.getPrevious();
        if (prev && prev.get()) {
          viewSequence = prev;
        } else {
          break;
        }
      }
      _scrollToSequence.call(this, viewSequence, false);
      return this;
    };
    ScrollController.prototype.goToPreviousPage = function() {
      _goToPage.call(this, -1);
      return this;
    };
    ScrollController.prototype.goToNextPage = function() {
      _goToPage.call(this, 1);
      return this;
    };
    ScrollController.prototype.goToLastPage = function() {
      if (!this._viewSequence) {
        return this;
      }
      if (this._viewSequence._ && this._viewSequence._.loop) {
        LayoutUtility.error('Unable to go to last item of looped ViewSequence');
        return this;
      }
      var viewSequence = this._viewSequence;
      while (viewSequence) {
        var next = viewSequence.getNext();
        if (next && next.get()) {
          viewSequence = next;
        } else {
          break;
        }
      }
      _scrollToSequence.call(this, viewSequence, true);
      return this;
    };
    ScrollController.prototype.goToRenderNode = function(node) {
      if (!this._viewSequence || !node) {
        return this;
      }
      if (this._viewSequence.get() === node) {
        var next = _calcScrollOffset.call(this) >= 0;
        _scrollToSequence.call(this, this._viewSequence, next);
        return this;
      }
      var nextSequence = this._viewSequence.getNext();
      var prevSequence = this._viewSequence.getPrevious();
      while ((nextSequence || prevSequence) && (nextSequence !== this._viewSequence)) {
        var nextNode = nextSequence ? nextSequence.get() : undefined;
        if (nextNode === node) {
          _scrollToSequence.call(this, nextSequence, true);
          break;
        }
        var prevNode = prevSequence ? prevSequence.get() : undefined;
        if (prevNode === node) {
          _scrollToSequence.call(this, prevSequence, false);
          break;
        }
        nextSequence = nextNode ? nextSequence.getNext() : undefined;
        prevSequence = prevNode ? prevSequence.getPrevious() : undefined;
      }
      return this;
    };
    ScrollController.prototype.ensureVisible = function(node) {
      if (node instanceof ViewSequence) {
        node = node.get();
      } else if ((node instanceof Number) || (typeof node === 'number')) {
        var viewSequence = this._viewSequence;
        while (viewSequence.getIndex() < node) {
          viewSequence = viewSequence.getNext();
          if (!viewSequence) {
            return this;
          }
        }
        while (viewSequence.getIndex() > node) {
          viewSequence = viewSequence.getPrevious();
          if (!viewSequence) {
            return this;
          }
        }
      }
      if (this._viewSequence.get() === node) {
        var next = _calcScrollOffset.call(this) >= 0;
        _ensureVisibleSequence.call(this, this._viewSequence, next);
        return this;
      }
      var nextSequence = this._viewSequence.getNext();
      var prevSequence = this._viewSequence.getPrevious();
      while ((nextSequence || prevSequence) && (nextSequence !== this._viewSequence)) {
        var nextNode = nextSequence ? nextSequence.get() : undefined;
        if (nextNode === node) {
          _ensureVisibleSequence.call(this, nextSequence, true);
          break;
        }
        var prevNode = prevSequence ? prevSequence.get() : undefined;
        if (prevNode === node) {
          _ensureVisibleSequence.call(this, prevSequence, false);
          break;
        }
        nextSequence = nextNode ? nextSequence.getNext() : undefined;
        prevSequence = prevNode ? prevSequence.getPrevious() : undefined;
      }
      return this;
    };
    ScrollController.prototype.scroll = function(delta) {
      this.halt();
      this._scroll.scrollDelta += delta;
      return this;
    };
    ScrollController.prototype.canScroll = function(delta) {
      var scrollOffset = _calcScrollOffset.call(this);
      var prevHeight = this._calcScrollHeight(false);
      var nextHeight = this._calcScrollHeight(true);
      var totalHeight;
      if ((nextHeight !== undefined) && (prevHeight !== undefined)) {
        totalHeight = prevHeight + nextHeight;
      }
      if ((totalHeight !== undefined) && (totalHeight <= this._contextSizeCache[this._direction])) {
        return 0;
      }
      if ((delta < 0) && (nextHeight !== undefined)) {
        var nextOffset = this._contextSizeCache[this._direction] - (scrollOffset + nextHeight);
        return Math.max(nextOffset, delta);
      } else if ((delta > 0) && (prevHeight !== undefined)) {
        var prevOffset = -(scrollOffset - prevHeight);
        return Math.min(prevOffset, delta);
      }
      return delta;
    };
    ScrollController.prototype.halt = function() {
      this._scroll.scrollToSequence = undefined;
      this._scroll.scrollToRenderNode = undefined;
      this._scroll.ensureVisibleRenderNode = undefined;
      _setParticle.call(this, undefined, 0, 'halt');
      return this;
    };
    ScrollController.prototype.isScrolling = function() {
      return this._scroll.isScrolling;
    };
    ScrollController.prototype.getBoundsReached = function() {
      return this._scroll.boundsReached;
    };
    ScrollController.prototype.getVelocity = function() {
      return this._scroll.particle.getVelocity1D();
    };
    ScrollController.prototype.setVelocity = function(velocity) {
      return this._scroll.particle.setVelocity1D(velocity);
    };
    ScrollController.prototype.applyScrollForce = function(delta) {
      this.halt();
      if (this._scroll.scrollForceCount === 0) {
        this._scroll.scrollForceStartItem = this.alignment ? this.getLastVisibleItem() : this.getFirstVisibleItem();
      }
      this._scroll.scrollForceCount++;
      this._scroll.scrollForce += delta;
      return this;
    };
    ScrollController.prototype.updateScrollForce = function(prevDelta, newDelta) {
      this.halt();
      newDelta -= prevDelta;
      this._scroll.scrollForce += newDelta;
      return this;
    };
    ScrollController.prototype.releaseScrollForce = function(delta, velocity) {
      this.halt();
      if (this._scroll.scrollForceCount === 1) {
        var scrollOffset = _calcScrollOffset.call(this);
        _setParticle.call(this, scrollOffset, velocity, 'releaseScrollForce');
        this._scroll.pe.wake();
        this._scroll.scrollForce = 0;
        this._scroll.scrollDirty = true;
        if (this._scroll.scrollForceStartItem && this.options.paginated && (this.options.paginationMode === PaginationMode.PAGE)) {
          var item = this.alignment ? this.getLastVisibleItem() : this.getFirstVisibleItem();
          if (item.renderNode !== this._scroll.scrollForceStartItem.renderNode) {
            this.goToRenderNode(item.renderNode);
          } else if (this.options.paginationEnergyThresshold && (Math.abs(this._scroll.particle.getEnergy()) >= this.options.paginationEnergyThresshold)) {
            velocity = velocity || 0;
            if ((velocity < 0) && item._node._next && item._node._next.renderNode) {
              this.goToRenderNode(item._node._next.renderNode);
            } else if ((velocity >= 0) && item._node._prev && item._node._prev.renderNode) {
              this.goToRenderNode(item._node._prev.renderNode);
            }
          } else {
            this.goToRenderNode(item.renderNode);
          }
        }
        this._scroll.scrollForceStartItem = undefined;
      } else {
        this._scroll.scrollForce -= delta;
      }
      this._scroll.scrollForceCount--;
      return this;
    };
    ScrollController.prototype.getSpec = function(node, normalize) {
      var spec = LayoutController.prototype.getSpec.apply(this, arguments);
      if (spec && this._layout.capabilities && this._layout.capabilities.sequentialScrollingOptimized) {
        spec = {
          origin: spec.origin,
          align: spec.align,
          opacity: spec.opacity,
          size: spec.size,
          renderNode: spec.renderNode,
          transform: spec.transform
        };
        var translate = [0, 0, 0];
        translate[this._direction] = this._scrollOffsetCache + this._scroll.groupStart;
        spec.transform = Transform.thenMove(spec.transform, translate);
      }
      return spec;
    };
    function _layout(size, scrollOffset, nested) {
      this._debug.layoutCount++;
      var scrollStart = 0 - Math.max(this.options.extraBoundsSpace[0], 1);
      var scrollEnd = size[this._direction] + Math.max(this.options.extraBoundsSpace[1], 1);
      if (this.options.layoutAll) {
        scrollStart = -1000000;
        scrollEnd = 1000000;
      }
      var layoutContext = this._nodes.prepareForLayout(this._viewSequence, this._nodesById, {
        size: size,
        direction: this._direction,
        reverse: this.options.alignment ? true : false,
        scrollOffset: this.options.alignment ? (scrollOffset + size[this._direction]) : scrollOffset,
        scrollStart: scrollStart,
        scrollEnd: scrollEnd
      });
      if (this._layout._function) {
        this._layout._function(layoutContext, this._layout.options);
      }
      this._scroll.unnormalizedScrollOffset = scrollOffset;
      if (this._postLayout) {
        this._postLayout(size, scrollOffset);
      }
      this._nodes.removeNonInvalidatedNodes(this.options.removeSpec);
      _calcBounds.call(this, size, scrollOffset);
      _calcScrollToOffset.call(this, size, scrollOffset);
      _snapToPage.call(this);
      var newScrollOffset = _calcScrollOffset.call(this, true);
      if (!nested && (newScrollOffset !== scrollOffset)) {
        return _layout.call(this, size, newScrollOffset, true);
      }
      scrollOffset = _normalizeViewSequence.call(this, size, scrollOffset);
      _updateSpring.call(this);
      this._nodes.removeVirtualViewSequenceNodes();
      return scrollOffset;
    }
    function _innerRender() {
      var specs = this._specs;
      for (var i3 = 0,
          j3 = specs.length; i3 < j3; i3++) {
        specs[i3].target = specs[i3].renderNode.render();
      }
      return specs;
    }
    ScrollController.prototype.commit = function commit(context) {
      var size = context.size;
      this._debug.commitCount++;
      var scrollOffset = _calcScrollOffset.call(this, true, true);
      if (this._scrollOffsetCache === undefined) {
        this._scrollOffsetCache = scrollOffset;
      }
      var emitEndScrollingEvent = false;
      var emitScrollEvent = false;
      var eventData;
      if (size[0] !== this._contextSizeCache[0] || size[1] !== this._contextSizeCache[1] || this._isDirty || this._scroll.scrollDirty || this._nodes._trueSizeRequested || this.options.alwaysLayout || this._scrollOffsetCache !== scrollOffset) {
        eventData = {
          target: this,
          oldSize: this._contextSizeCache,
          size: size,
          oldScrollOffset: this._scrollOffsetCache,
          scrollOffset: scrollOffset
        };
        if (this._scrollOffsetCache !== scrollOffset) {
          if (!this._scroll.isScrolling) {
            this._scroll.isScrolling = true;
            this._eventOutput.emit('scrollstart', eventData);
          }
          emitScrollEvent = true;
        } else if (this._scroll.isScrolling && !this._scroll.scrollForceCount) {
          emitEndScrollingEvent = true;
        }
        this._eventOutput.emit('layoutstart', eventData);
        if (this.options.flow && (this._isDirty || (this.options.reflowOnResize && ((size[0] !== this._contextSizeCache[0]) || (size[1] !== this._contextSizeCache[1]))))) {
          var node = this._nodes.getStartEnumNode();
          while (node) {
            node.releaseLock();
            node = node._next;
          }
        }
        this._contextSizeCache[0] = size[0];
        this._contextSizeCache[1] = size[1];
        this._isDirty = false;
        this._scroll.scrollDirty = false;
        scrollOffset = _layout.call(this, size, scrollOffset);
        this._scrollOffsetCache = scrollOffset;
        eventData.scrollOffset = this._scrollOffsetCache;
        this._eventOutput.emit('layoutend', eventData);
      } else if (this._scroll.isScrolling && !this._scroll.scrollForceCount) {
        emitEndScrollingEvent = true;
      }
      var groupTranslate = this._scroll.groupTranslate;
      groupTranslate[0] = 0;
      groupTranslate[1] = 0;
      groupTranslate[2] = 0;
      groupTranslate[this._direction] = -this._scroll.groupStart - scrollOffset;
      var sequentialScrollingOptimized = this._layout.capabilities ? this._layout.capabilities.sequentialScrollingOptimized : false;
      var result = this._nodes.buildSpecAndDestroyUnrenderedNodes(sequentialScrollingOptimized ? groupTranslate : undefined);
      this._specs = result.specs;
      if (result.modified) {
        this._eventOutput.emit('reflow', {target: this});
      }
      if (emitScrollEvent) {
        this._eventOutput.emit('scroll', eventData);
      }
      if (eventData) {
        var visibleItem = this.options.alignment ? this.getLastVisibleItem() : this.getFirstVisibleItem();
        if ((visibleItem && !this._visibleItemCache) || (!visibleItem && this._visibleItemCache) || (visibleItem && this._visibleItemCache && (visibleItem.renderNode !== this._visibleItemCache.renderNode))) {
          this._eventOutput.emit('pagechange', {
            target: this,
            oldViewSequence: this._visibleItemCache ? this._visibleItemCache.viewSequence : undefined,
            viewSequence: visibleItem ? visibleItem.viewSequence : undefined,
            oldIndex: this._visibleItemCache ? this._visibleItemCache.index : undefined,
            index: visibleItem ? visibleItem.index : undefined,
            renderNode: visibleItem ? visibleItem.renderNode : undefined,
            oldRenderNode: this._visibleItemCache ? this._visibleItemCache.renderNode : undefined
          });
          this._visibleItemCache = visibleItem;
        }
      }
      if (emitEndScrollingEvent) {
        this._scroll.isScrolling = false;
        eventData = {
          target: this,
          oldSize: size,
          size: size,
          oldScrollOffset: scrollOffset,
          scrollOffset: scrollOffset
        };
        this._eventOutput.emit('scrollend', eventData);
      }
      var transform = context.transform;
      if (sequentialScrollingOptimized) {
        var windowOffset = scrollOffset + this._scroll.groupStart;
        var translate = [0, 0, 0];
        translate[this._direction] = windowOffset;
        transform = Transform.thenMove(transform, translate);
      }
      return {
        transform: transform,
        size: size,
        opacity: context.opacity,
        origin: context.origin,
        target: this.group.render()
      };
    };
    ScrollController.prototype.render = function render() {
      if (this.container) {
        return this.container.render.apply(this.container, arguments);
      } else {
        return this.id;
      }
    };
    module.exports = ScrollController;
  }).call(__exports, __require, __exports, __module);
});


})();
(function() {
function define(){};  define.amd = {};
System.register("github:IjzerenHein/famous-flex@0.2.0/src/layouts/CollectionLayout", ["npm:famous@0.3.5/utilities/Utility", "github:IjzerenHein/famous-flex@0.2.0/src/LayoutUtility"], false, function(__require, __exports, __module) {
  return (function(require, exports, module) {
    var Utility = require("npm:famous@0.3.5/utilities/Utility");
    var LayoutUtility = require("github:IjzerenHein/famous-flex@0.2.0/src/LayoutUtility");
    var capabilities = {
      sequence: true,
      direction: [Utility.Direction.Y, Utility.Direction.X],
      scrolling: true,
      trueSize: true,
      sequentialScrollingOptimized: true
    };
    var context;
    var size;
    var direction;
    var alignment;
    var lineDirection;
    var lineLength;
    var offset;
    var margins;
    var margin = [0, 0];
    var spacing;
    var justify;
    var itemSize;
    var getItemSize;
    var lineNodes;
    function _layoutLine(next, endReached) {
      if (!lineNodes.length) {
        return 0;
      }
      var i;
      var lineSize = [0, 0];
      var lineNode;
      for (i = 0; i < lineNodes.length; i++) {
        lineSize[direction] = Math.max(lineSize[direction], lineNodes[i].size[direction]);
        lineSize[lineDirection] += ((i > 0) ? spacing[lineDirection] : 0) + lineNodes[i].size[lineDirection];
      }
      var justifyOffset = justify[lineDirection] ? ((lineLength - lineSize[lineDirection]) / (lineNodes.length * 2)) : 0;
      var lineOffset = (direction ? margins[3] : margins[0]) + justifyOffset;
      var scrollLength;
      for (i = 0; i < lineNodes.length; i++) {
        lineNode = lineNodes[i];
        var translate = [0, 0, 0];
        translate[lineDirection] = lineOffset;
        translate[direction] = next ? offset : (offset - (lineSize[direction]));
        scrollLength = 0;
        if (i === 0) {
          scrollLength = lineSize[direction];
          if (endReached && ((next && !alignment) || (!next && alignment))) {
            scrollLength += direction ? (margins[0] + margins[2]) : (margins[3] + margins[1]);
          } else {
            scrollLength += spacing[direction];
          }
        }
        lineNode.set = {
          size: lineNode.size,
          translate: translate,
          scrollLength: scrollLength
        };
        lineOffset += lineNode.size[lineDirection] + spacing[lineDirection] + (justifyOffset * 2);
      }
      for (i = 0; i < lineNodes.length; i++) {
        lineNode = next ? lineNodes[i] : lineNodes[(lineNodes.length - 1) - i];
        context.set(lineNode.node, lineNode.set);
      }
      lineNodes = [];
      return lineSize[direction] + spacing[direction];
    }
    function _resolveNodeSize(node) {
      var localItemSize = itemSize;
      if (getItemSize) {
        localItemSize = getItemSize(node.renderNode, size);
      }
      if ((localItemSize[0] === true) || (localItemSize[1] === true)) {
        var result = context.resolveSize(node, size);
        if (localItemSize[0] !== true) {
          result[0] = itemSize[0];
        }
        if (localItemSize[1] !== true) {
          result[1] = itemSize[1];
        }
        return result;
      } else {
        return localItemSize;
      }
    }
    function CollectionLayout(context_, options) {
      context = context_;
      size = context.size;
      direction = context.direction;
      alignment = context.alignment;
      lineDirection = (direction + 1) % 2;
      if ((options.gutter !== undefined) && console.warn) {
        console.warn('option `gutter` has been deprecated for CollectionLayout, use margins & spacing instead');
      }
      if (options.gutter && !options.margins && !options.spacing) {
        var gutter = Array.isArray(options.gutter) ? options.gutter : [options.gutter, options.gutter];
        margins = [gutter[1], gutter[0], gutter[1], gutter[0]];
        spacing = gutter;
      } else {
        margins = LayoutUtility.normalizeMargins(options.margins);
        spacing = options.spacing || 0;
        spacing = Array.isArray(spacing) ? spacing : [spacing, spacing];
      }
      margin[0] = margins[direction ? 0 : 3];
      margin[1] = -margins[direction ? 2 : 1];
      justify = Array.isArray(options.justify) ? options.justify : (options.justify ? [true, true] : [false, false]);
      lineLength = size[lineDirection] - (direction ? (margins[3] + margins[1]) : (margins[0] + margins[2]));
      var node;
      var nodeSize;
      var lineOffset;
      var bound;
      if (options.cells) {
        if (options.itemSize && console.warn) {
          console.warn('options `cells` and `itemSize` cannot both be specified for CollectionLayout, only use one of the two');
        }
        itemSize = [(size[0] - (margins[1] + margins[3] + (spacing[0] * (options.cells[0] - 1)))) / options.cells[0], (size[1] - (margins[0] + margins[2] + (spacing[1] * (options.cells[1] - 1)))) / options.cells[1]];
      } else if (!options.itemSize) {
        itemSize = [true, true];
      } else if (options.itemSize instanceof Function) {
        getItemSize = options.itemSize;
      } else if ((options.itemSize[0] === undefined) || (options.itemSize[0] === undefined)) {
        itemSize = [(options.itemSize[0] === undefined) ? size[0] : options.itemSize[0], (options.itemSize[1] === undefined) ? size[1] : options.itemSize[1]];
      } else {
        itemSize = options.itemSize;
      }
      offset = context.scrollOffset + (alignment ? 0 : margin[alignment]);
      bound = context.scrollEnd + (alignment ? 0 : margin[alignment]);
      lineOffset = 0;
      lineNodes = [];
      while (offset < bound) {
        node = context.next();
        if (!node) {
          _layoutLine(true, true);
          break;
        }
        nodeSize = _resolveNodeSize(node);
        lineOffset += (lineNodes.length ? spacing[lineDirection] : 0) + nodeSize[lineDirection];
        if (lineOffset > lineLength) {
          offset += _layoutLine(true, !node);
          lineOffset = nodeSize[lineDirection];
        }
        lineNodes.push({
          node: node,
          size: nodeSize
        });
      }
      offset = context.scrollOffset + (alignment ? margin[alignment] : 0);
      bound = context.scrollStart + (alignment ? margin[alignment] : 0);
      lineOffset = 0;
      lineNodes = [];
      while (offset > bound) {
        node = context.prev();
        if (!node) {
          _layoutLine(false, true);
          break;
        }
        nodeSize = _resolveNodeSize(node);
        lineOffset += (lineNodes.length ? spacing[lineDirection] : 0) + nodeSize[lineDirection];
        if (lineOffset > lineLength) {
          offset -= _layoutLine(false, !node);
          lineOffset = nodeSize[lineDirection];
        }
        lineNodes.unshift({
          node: node,
          size: nodeSize
        });
      }
    }
    CollectionLayout.Capabilities = capabilities;
    CollectionLayout.Name = 'CollectionLayout';
    CollectionLayout.Description = 'Multi-cell collection-layout with margins & spacing';
    module.exports = CollectionLayout;
  }).call(__exports, __require, __exports, __module);
});


})();
(function() {
function define(){};  define.amd = {};
System.register("github:IjzerenHein/famous-flex@0.2.0/src/layouts/ListLayout", ["npm:famous@0.3.5/utilities/Utility", "github:IjzerenHein/famous-flex@0.2.0/src/LayoutUtility"], false, function(__require, __exports, __module) {
  return (function(require, exports, module) {
    var Utility = require("npm:famous@0.3.5/utilities/Utility");
    var LayoutUtility = require("github:IjzerenHein/famous-flex@0.2.0/src/LayoutUtility");
    var capabilities = {
      sequence: true,
      direction: [Utility.Direction.Y, Utility.Direction.X],
      scrolling: true,
      trueSize: true,
      sequentialScrollingOptimized: true
    };
    var set = {
      size: [0, 0],
      translate: [0, 0, 0],
      scrollLength: undefined
    };
    var margin = [0, 0];
    function ListLayout(context, options) {
      var size = context.size;
      var direction = context.direction;
      var alignment = context.alignment;
      var revDirection = direction ? 0 : 1;
      var offset;
      var margins = LayoutUtility.normalizeMargins(options.margins);
      var spacing = options.spacing || 0;
      var node;
      var nodeSize;
      var itemSize;
      var getItemSize;
      var lastSectionBeforeVisibleCell;
      var lastSectionBeforeVisibleCellOffset;
      var lastSectionBeforeVisibleCellLength;
      var lastSectionBeforeVisibleCellScrollLength;
      var firstVisibleCell;
      var lastNode;
      var lastCellOffsetInFirstVisibleSection;
      var isSectionCallback = options.isSectionCallback;
      var bound;
      set.size[0] = size[0];
      set.size[1] = size[1];
      set.size[revDirection] -= (margins[1 - revDirection] + margins[3 - revDirection]);
      set.translate[0] = 0;
      set.translate[1] = 0;
      set.translate[2] = 0;
      set.translate[revDirection] = margins[direction ? 3 : 0];
      if ((options.itemSize === true) || !options.hasOwnProperty('itemSize')) {
        itemSize = true;
      } else if (options.itemSize instanceof Function) {
        getItemSize = options.itemSize;
      } else {
        itemSize = (options.itemSize === undefined) ? size[direction] : options.itemSize;
      }
      margin[0] = margins[direction ? 0 : 3];
      margin[1] = -margins[direction ? 2 : 1];
      offset = context.scrollOffset + margin[alignment];
      bound = context.scrollEnd + margin[alignment];
      while (offset < bound) {
        lastNode = node;
        node = context.next();
        if (!node) {
          if (lastNode && !alignment) {
            set.scrollLength = nodeSize + margin[0] + -margin[1];
            context.set(lastNode, set);
          }
          break;
        }
        nodeSize = getItemSize ? getItemSize(node.renderNode) : itemSize;
        nodeSize = (nodeSize === true) ? context.resolveSize(node, size)[direction] : nodeSize;
        set.size[direction] = nodeSize;
        set.translate[direction] = offset + (alignment ? spacing : 0);
        set.scrollLength = nodeSize + spacing;
        context.set(node, set);
        offset += set.scrollLength;
        if (isSectionCallback && isSectionCallback(node.renderNode)) {
          set.translate[direction] = Math.max(margin[0], set.translate[direction]);
          context.set(node, set);
          if (!firstVisibleCell) {
            lastSectionBeforeVisibleCell = node;
            lastSectionBeforeVisibleCellOffset = offset - nodeSize;
            lastSectionBeforeVisibleCellLength = nodeSize;
            lastSectionBeforeVisibleCellScrollLength = nodeSize;
          } else if (lastCellOffsetInFirstVisibleSection === undefined) {
            lastCellOffsetInFirstVisibleSection = offset - nodeSize;
          }
        } else if (!firstVisibleCell && (offset >= 0)) {
          firstVisibleCell = node;
        }
      }
      node = undefined;
      offset = context.scrollOffset + margin[alignment];
      bound = context.scrollStart + margin[alignment];
      while (offset > bound) {
        lastNode = node;
        node = context.prev();
        if (!node) {
          if (lastNode && alignment) {
            set.scrollLength = nodeSize + margin[0] + -margin[1];
            context.set(lastNode, set);
            if (lastSectionBeforeVisibleCell === lastNode) {
              lastSectionBeforeVisibleCellScrollLength = set.scrollLength;
            }
          }
          break;
        }
        nodeSize = getItemSize ? getItemSize(node.renderNode) : itemSize;
        nodeSize = (nodeSize === true) ? context.resolveSize(node, size)[direction] : nodeSize;
        set.scrollLength = nodeSize + spacing;
        offset -= set.scrollLength;
        set.size[direction] = nodeSize;
        set.translate[direction] = offset + (alignment ? spacing : 0);
        context.set(node, set);
        if (isSectionCallback && isSectionCallback(node.renderNode)) {
          set.translate[direction] = Math.max(margin[0], set.translate[direction]);
          context.set(node, set);
          if (!lastSectionBeforeVisibleCell) {
            lastSectionBeforeVisibleCell = node;
            lastSectionBeforeVisibleCellOffset = offset;
            lastSectionBeforeVisibleCellLength = nodeSize;
            lastSectionBeforeVisibleCellScrollLength = set.scrollLength;
          }
        } else if ((offset + nodeSize) >= 0) {
          firstVisibleCell = node;
          if (lastSectionBeforeVisibleCell) {
            lastCellOffsetInFirstVisibleSection = offset + nodeSize;
          }
          lastSectionBeforeVisibleCell = undefined;
        }
      }
      if (isSectionCallback && !lastSectionBeforeVisibleCell) {
        node = context.prev();
        while (node) {
          if (isSectionCallback(node.renderNode)) {
            lastSectionBeforeVisibleCell = node;
            nodeSize = options.itemSize || context.resolveSize(node, size)[direction];
            lastSectionBeforeVisibleCellOffset = offset - nodeSize;
            lastSectionBeforeVisibleCellLength = nodeSize;
            lastSectionBeforeVisibleCellScrollLength = undefined;
            break;
          } else {
            node = context.prev();
          }
        }
      }
      if (lastSectionBeforeVisibleCell) {
        var correctedOffset = Math.max(margin[0], lastSectionBeforeVisibleCellOffset);
        if ((lastCellOffsetInFirstVisibleSection !== undefined) && (lastSectionBeforeVisibleCellLength > (lastCellOffsetInFirstVisibleSection - margin[0]))) {
          correctedOffset = ((lastCellOffsetInFirstVisibleSection - lastSectionBeforeVisibleCellLength));
        }
        set.size[direction] = lastSectionBeforeVisibleCellLength;
        set.translate[direction] = correctedOffset;
        set.scrollLength = lastSectionBeforeVisibleCellScrollLength;
        context.set(lastSectionBeforeVisibleCell, set);
      }
    }
    ListLayout.Capabilities = capabilities;
    ListLayout.Name = 'ListLayout';
    ListLayout.Description = 'List-layout with margins, spacing and sticky headers';
    module.exports = ListLayout;
  }).call(__exports, __require, __exports, __module);
});


})();
(function() {
function define(){};  define.amd = {};
System.register("github:IjzerenHein/famous-flex@0.2.0/src/layouts/WheelLayout", ["npm:famous@0.3.5/utilities/Utility"], false, function(__require, __exports, __module) {
  return (function(require, exports, module) {
    var Utility = require("npm:famous@0.3.5/utilities/Utility");
    var capabilities = {
      sequence: true,
      direction: [Utility.Direction.Y, Utility.Direction.X],
      scrolling: true,
      trueSize: true
    };
    var size;
    var direction;
    var revDirection;
    var node;
    var itemSize;
    var diameter;
    var offset;
    var bound;
    var angle;
    var radius;
    var itemAngle;
    var radialOpacity;
    var set = {
      opacity: 1,
      size: [0, 0],
      translate: [0, 0, 0],
      rotate: [0, 0, 0],
      origin: [0.5, 0.5],
      align: [0.5, 0.5],
      scrollLength: undefined
    };
    function WheelLayout(context, options) {
      size = context.size;
      direction = context.direction;
      revDirection = direction ? 0 : 1;
      itemSize = options.itemSize || (size[direction] / 2);
      diameter = options.diameter || (itemSize * 3);
      radius = diameter / 2;
      itemAngle = Math.atan2((itemSize / 2), radius) * 2;
      radialOpacity = (options.radialOpacity === undefined) ? 1 : options.radialOpacity;
      set.opacity = 1;
      set.size[0] = size[0];
      set.size[1] = size[1];
      set.size[revDirection] = size[revDirection];
      set.size[direction] = itemSize;
      set.translate[0] = 0;
      set.translate[1] = 0;
      set.translate[2] = 0;
      set.rotate[0] = 0;
      set.rotate[1] = 0;
      set.rotate[2] = 0;
      set.scrollLength = itemSize;
      offset = context.scrollOffset;
      bound = (((Math.PI / 2) / itemAngle) * itemSize) + itemSize;
      while (offset <= bound) {
        node = context.next();
        if (!node) {
          break;
        }
        if (offset >= -bound) {
          angle = (offset / itemSize) * itemAngle;
          set.translate[direction] = radius * Math.sin(angle);
          set.translate[2] = (radius * Math.cos(angle)) - radius;
          set.rotate[revDirection] = direction ? -angle : angle;
          set.opacity = 1 - ((Math.abs(angle) / (Math.PI / 2)) * (1 - radialOpacity));
          context.set(node, set);
        }
        offset += itemSize;
      }
      offset = context.scrollOffset - itemSize;
      while (offset >= -bound) {
        node = context.prev();
        if (!node) {
          break;
        }
        if (offset <= bound) {
          angle = (offset / itemSize) * itemAngle;
          set.translate[direction] = radius * Math.sin(angle);
          set.translate[2] = (radius * Math.cos(angle)) - radius;
          set.rotate[revDirection] = direction ? -angle : angle;
          set.opacity = 1 - ((Math.abs(angle) / (Math.PI / 2)) * (1 - radialOpacity));
          context.set(node, set);
        }
        offset -= itemSize;
      }
    }
    WheelLayout.Capabilities = capabilities;
    WheelLayout.Name = 'WheelLayout';
    WheelLayout.Description = 'Spinner-wheel/slot-machine layout';
    module.exports = WheelLayout;
  }).call(__exports, __require, __exports, __module);
});


})();
System.register("npm:famous@0.3.5/core/SpecParser", ["npm:famous@0.3.5/core/Transform"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var Transform = require("npm:famous@0.3.5/core/Transform");
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
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/core/EventHandler", ["npm:famous@0.3.5/core/EventEmitter"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var EventEmitter = require("npm:famous@0.3.5/core/EventEmitter");
  function EventHandler() {
    EventEmitter.apply(this, arguments);
    this.downstream = [];
    this.downstreamFn = [];
    this.upstream = [];
    this.upstreamListeners = {};
  }
  EventHandler.prototype = Object.create(EventEmitter.prototype);
  EventHandler.prototype.constructor = EventHandler;
  EventHandler.setInputHandler = function setInputHandler(object, handler) {
    object.trigger = handler.trigger.bind(handler);
    if (handler.subscribe && handler.unsubscribe) {
      object.subscribe = handler.subscribe.bind(handler);
      object.unsubscribe = handler.unsubscribe.bind(handler);
    }
  };
  EventHandler.setOutputHandler = function setOutputHandler(object, handler) {
    if (handler instanceof EventHandler)
      handler.bindThis(object);
    object.pipe = handler.pipe.bind(handler);
    object.unpipe = handler.unpipe.bind(handler);
    object.on = handler.on.bind(handler);
    object.addListener = object.on;
    object.removeListener = handler.removeListener.bind(handler);
  };
  EventHandler.prototype.emit = function emit(type, event) {
    EventEmitter.prototype.emit.apply(this, arguments);
    var i = 0;
    for (i = 0; i < this.downstream.length; i++) {
      if (this.downstream[i].trigger)
        this.downstream[i].trigger(type, event);
    }
    for (i = 0; i < this.downstreamFn.length; i++) {
      this.downstreamFn[i](type, event);
    }
    return this;
  };
  EventHandler.prototype.trigger = EventHandler.prototype.emit;
  EventHandler.prototype.pipe = function pipe(target) {
    if (target.subscribe instanceof Function)
      return target.subscribe(this);
    var downstreamCtx = target instanceof Function ? this.downstreamFn : this.downstream;
    var index = downstreamCtx.indexOf(target);
    if (index < 0)
      downstreamCtx.push(target);
    if (target instanceof Function)
      target('pipe', null);
    else if (target.trigger)
      target.trigger('pipe', null);
    return target;
  };
  EventHandler.prototype.unpipe = function unpipe(target) {
    if (target.unsubscribe instanceof Function)
      return target.unsubscribe(this);
    var downstreamCtx = target instanceof Function ? this.downstreamFn : this.downstream;
    var index = downstreamCtx.indexOf(target);
    if (index >= 0) {
      downstreamCtx.splice(index, 1);
      if (target instanceof Function)
        target('unpipe', null);
      else if (target.trigger)
        target.trigger('unpipe', null);
      return target;
    } else
      return false;
  };
  EventHandler.prototype.on = function on(type, handler) {
    EventEmitter.prototype.on.apply(this, arguments);
    if (!(type in this.upstreamListeners)) {
      var upstreamListener = this.trigger.bind(this, type);
      this.upstreamListeners[type] = upstreamListener;
      for (var i = 0; i < this.upstream.length; i++) {
        this.upstream[i].on(type, upstreamListener);
      }
    }
    return this;
  };
  EventHandler.prototype.addListener = EventHandler.prototype.on;
  EventHandler.prototype.subscribe = function subscribe(source) {
    var index = this.upstream.indexOf(source);
    if (index < 0) {
      this.upstream.push(source);
      for (var type in this.upstreamListeners) {
        source.on(type, this.upstreamListeners[type]);
      }
    }
    return this;
  };
  EventHandler.prototype.unsubscribe = function unsubscribe(source) {
    var index = this.upstream.indexOf(source);
    if (index >= 0) {
      this.upstream.splice(index, 1);
      for (var type in this.upstreamListeners) {
        source.removeListener(type, this.upstreamListeners[type]);
      }
    }
    return this;
  };
  module.exports = EventHandler;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/transitions/MultipleTransition", ["npm:famous@0.3.5/utilities/Utility"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var Utility = require("npm:famous@0.3.5/utilities/Utility");
  function MultipleTransition(method) {
    this.method = method;
    this._instances = [];
    this.state = [];
  }
  MultipleTransition.SUPPORTS_MULTIPLE = true;
  MultipleTransition.prototype.get = function get() {
    for (var i = 0; i < this._instances.length; i++) {
      this.state[i] = this._instances[i].get();
    }
    return this.state;
  };
  MultipleTransition.prototype.set = function set(endState, transition, callback) {
    var _allCallback = Utility.after(endState.length, callback);
    for (var i = 0; i < endState.length; i++) {
      if (!this._instances[i])
        this._instances[i] = new this.method();
      this._instances[i].set(endState[i], transition, _allCallback);
    }
  };
  MultipleTransition.prototype.reset = function reset(startState) {
    for (var i = 0; i < startState.length; i++) {
      if (!this._instances[i])
        this._instances[i] = new this.method();
      this._instances[i].reset(startState[i]);
    }
  };
  module.exports = MultipleTransition;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/core/Engine", ["npm:famous@0.3.5/core/Context", "npm:famous@0.3.5/core/EventHandler", "npm:famous@0.3.5/core/OptionsManager"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var Context = require("npm:famous@0.3.5/core/Context");
  var EventHandler = require("npm:famous@0.3.5/core/EventHandler");
  var OptionsManager = require("npm:famous@0.3.5/core/OptionsManager");
  var Engine = {};
  var contexts = [];
  var nextTickQueue = [];
  var currentFrame = 0;
  var nextTickFrame = 0;
  var deferQueue = [];
  var lastTime = Date.now();
  var frameTime;
  var frameTimeLimit;
  var loopEnabled = true;
  var eventForwarders = {};
  var eventHandler = new EventHandler();
  var options = {
    containerType: 'div',
    containerClass: 'famous-container',
    fpsCap: undefined,
    runLoop: true,
    appMode: true
  };
  var optionsManager = new OptionsManager(options);
  var MAX_DEFER_FRAME_TIME = 10;
  Engine.step = function step() {
    currentFrame++;
    nextTickFrame = currentFrame;
    var currentTime = Date.now();
    if (frameTimeLimit && currentTime - lastTime < frameTimeLimit)
      return ;
    var i = 0;
    frameTime = currentTime - lastTime;
    lastTime = currentTime;
    eventHandler.emit('prerender');
    var numFunctions = nextTickQueue.length;
    while (numFunctions--)
      nextTickQueue.shift()(currentFrame);
    while (deferQueue.length && Date.now() - currentTime < MAX_DEFER_FRAME_TIME) {
      deferQueue.shift().call(this);
    }
    for (i = 0; i < contexts.length; i++)
      contexts[i].update();
    eventHandler.emit('postrender');
  };
  function loop() {
    if (options.runLoop) {
      Engine.step();
      window.requestAnimationFrame(loop);
    } else
      loopEnabled = false;
  }
  window.requestAnimationFrame(loop);
  function handleResize(event) {
    for (var i = 0; i < contexts.length; i++) {
      contexts[i].emit('resize');
    }
    eventHandler.emit('resize');
  }
  window.addEventListener('resize', handleResize, false);
  handleResize();
  function initialize() {
    window.addEventListener('touchmove', function(event) {
      event.preventDefault();
    }, true);
    addRootClasses();
  }
  var initialized = false;
  function addRootClasses() {
    if (!document.body) {
      Engine.nextTick(addRootClasses);
      return ;
    }
    document.body.classList.add('famous-root');
    document.documentElement.classList.add('famous-root');
  }
  Engine.pipe = function pipe(target) {
    if (target.subscribe instanceof Function)
      return target.subscribe(Engine);
    else
      return eventHandler.pipe(target);
  };
  Engine.unpipe = function unpipe(target) {
    if (target.unsubscribe instanceof Function)
      return target.unsubscribe(Engine);
    else
      return eventHandler.unpipe(target);
  };
  Engine.on = function on(type, handler) {
    if (!(type in eventForwarders)) {
      eventForwarders[type] = eventHandler.emit.bind(eventHandler, type);
      addEngineListener(type, eventForwarders[type]);
    }
    return eventHandler.on(type, handler);
  };
  function addEngineListener(type, forwarder) {
    if (!document.body) {
      Engine.nextTick(addEventListener.bind(this, type, forwarder));
      return ;
    }
    document.body.addEventListener(type, forwarder);
  }
  Engine.emit = function emit(type, event) {
    return eventHandler.emit(type, event);
  };
  Engine.removeListener = function removeListener(type, handler) {
    return eventHandler.removeListener(type, handler);
  };
  Engine.getFPS = function getFPS() {
    return 1000 / frameTime;
  };
  Engine.setFPSCap = function setFPSCap(fps) {
    frameTimeLimit = Math.floor(1000 / fps);
  };
  Engine.getOptions = function getOptions(key) {
    return optionsManager.getOptions(key);
  };
  Engine.setOptions = function setOptions(options) {
    return optionsManager.setOptions.apply(optionsManager, arguments);
  };
  Engine.createContext = function createContext(el) {
    if (!initialized && options.appMode)
      Engine.nextTick(initialize);
    var needMountContainer = false;
    if (!el) {
      el = document.createElement(options.containerType);
      el.classList.add(options.containerClass);
      needMountContainer = true;
    }
    var context = new Context(el);
    Engine.registerContext(context);
    if (needMountContainer)
      mount(context, el);
    return context;
  };
  function mount(context, el) {
    if (!document.body) {
      Engine.nextTick(mount.bind(this, context, el));
      return ;
    }
    document.body.appendChild(el);
    context.emit('resize');
  }
  Engine.registerContext = function registerContext(context) {
    contexts.push(context);
    return context;
  };
  Engine.getContexts = function getContexts() {
    return contexts;
  };
  Engine.deregisterContext = function deregisterContext(context) {
    var i = contexts.indexOf(context);
    if (i >= 0)
      contexts.splice(i, 1);
  };
  Engine.nextTick = function nextTick(fn) {
    nextTickQueue.push(fn);
  };
  Engine.defer = function defer(fn) {
    deferQueue.push(fn);
  };
  optionsManager.on('change', function(data) {
    if (data.id === 'fpsCap')
      Engine.setFPSCap(data.value);
    else if (data.id === 'runLoop') {
      if (!loopEnabled && data.value) {
        loopEnabled = true;
        window.requestAnimationFrame(loop);
      }
    }
  });
  module.exports = Engine;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/core/Group", ["npm:famous@0.3.5/core/Context", "npm:famous@0.3.5/core/Transform", "npm:famous@0.3.5/core/Surface"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var Context = require("npm:famous@0.3.5/core/Context");
  var Transform = require("npm:famous@0.3.5/core/Transform");
  var Surface = require("npm:famous@0.3.5/core/Surface");
  function Group(options) {
    Surface.call(this, options);
    this._shouldRecalculateSize = false;
    this._container = document.createDocumentFragment();
    this.context = new Context(this._container);
    this.setContent(this._container);
    this._groupSize = [undefined, undefined];
  }
  Group.SIZE_ZERO = [0, 0];
  Group.prototype = Object.create(Surface.prototype);
  Group.prototype.elementType = 'div';
  Group.prototype.elementClass = 'famous-group';
  Group.prototype.add = function add() {
    return this.context.add.apply(this.context, arguments);
  };
  Group.prototype.render = function render() {
    return Surface.prototype.render.call(this);
  };
  Group.prototype.deploy = function deploy(target) {
    this.context.migrate(target);
  };
  Group.prototype.recall = function recall(target) {
    this._container = document.createDocumentFragment();
    this.context.migrate(this._container);
  };
  Group.prototype.commit = function commit(context) {
    var transform = context.transform;
    var origin = context.origin;
    var opacity = context.opacity;
    var size = context.size;
    var result = Surface.prototype.commit.call(this, {
      allocator: context.allocator,
      transform: Transform.thenMove(transform, [-origin[0] * size[0], -origin[1] * size[1], 0]),
      opacity: opacity,
      origin: origin,
      size: Group.SIZE_ZERO
    });
    if (size[0] !== this._groupSize[0] || size[1] !== this._groupSize[1]) {
      this._groupSize[0] = size[0];
      this._groupSize[1] = size[1];
      this.context.setSize(size);
    }
    this.context.update({
      transform: Transform.translate(-origin[0] * size[0], -origin[1] * size[1], 0),
      origin: origin,
      size: size
    });
    return result;
  };
  module.exports = Group;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/core/Modifier", ["npm:famous@0.3.5/core/Transform", "npm:famous@0.3.5/transitions/Transitionable", "npm:famous@0.3.5/transitions/TransitionableTransform"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var Transform = require("npm:famous@0.3.5/core/Transform");
  var Transitionable = require("npm:famous@0.3.5/transitions/Transitionable");
  var TransitionableTransform = require("npm:famous@0.3.5/transitions/TransitionableTransform");
  function Modifier(options) {
    this._transformGetter = null;
    this._opacityGetter = null;
    this._originGetter = null;
    this._alignGetter = null;
    this._sizeGetter = null;
    this._proportionGetter = null;
    this._legacyStates = {};
    this._output = {
      transform: Transform.identity,
      opacity: 1,
      origin: null,
      align: null,
      size: null,
      proportions: null,
      target: null
    };
    if (options) {
      if (options.transform)
        this.transformFrom(options.transform);
      if (options.opacity !== undefined)
        this.opacityFrom(options.opacity);
      if (options.origin)
        this.originFrom(options.origin);
      if (options.align)
        this.alignFrom(options.align);
      if (options.size)
        this.sizeFrom(options.size);
      if (options.proportions)
        this.proportionsFrom(options.proportions);
    }
  }
  Modifier.prototype.transformFrom = function transformFrom(transform) {
    if (transform instanceof Function)
      this._transformGetter = transform;
    else if (transform instanceof Object && transform.get)
      this._transformGetter = transform.get.bind(transform);
    else {
      this._transformGetter = null;
      this._output.transform = transform;
    }
    return this;
  };
  Modifier.prototype.opacityFrom = function opacityFrom(opacity) {
    if (opacity instanceof Function)
      this._opacityGetter = opacity;
    else if (opacity instanceof Object && opacity.get)
      this._opacityGetter = opacity.get.bind(opacity);
    else {
      this._opacityGetter = null;
      this._output.opacity = opacity;
    }
    return this;
  };
  Modifier.prototype.originFrom = function originFrom(origin) {
    if (origin instanceof Function)
      this._originGetter = origin;
    else if (origin instanceof Object && origin.get)
      this._originGetter = origin.get.bind(origin);
    else {
      this._originGetter = null;
      this._output.origin = origin;
    }
    return this;
  };
  Modifier.prototype.alignFrom = function alignFrom(align) {
    if (align instanceof Function)
      this._alignGetter = align;
    else if (align instanceof Object && align.get)
      this._alignGetter = align.get.bind(align);
    else {
      this._alignGetter = null;
      this._output.align = align;
    }
    return this;
  };
  Modifier.prototype.sizeFrom = function sizeFrom(size) {
    if (size instanceof Function)
      this._sizeGetter = size;
    else if (size instanceof Object && size.get)
      this._sizeGetter = size.get.bind(size);
    else {
      this._sizeGetter = null;
      this._output.size = size;
    }
    return this;
  };
  Modifier.prototype.proportionsFrom = function proportionsFrom(proportions) {
    if (proportions instanceof Function)
      this._proportionGetter = proportions;
    else if (proportions instanceof Object && proportions.get)
      this._proportionGetter = proportions.get.bind(proportions);
    else {
      this._proportionGetter = null;
      this._output.proportions = proportions;
    }
    return this;
  };
  Modifier.prototype.setTransform = function setTransform(transform, transition, callback) {
    if (transition || this._legacyStates.transform) {
      if (!this._legacyStates.transform) {
        this._legacyStates.transform = new TransitionableTransform(this._output.transform);
      }
      if (!this._transformGetter)
        this.transformFrom(this._legacyStates.transform);
      this._legacyStates.transform.set(transform, transition, callback);
      return this;
    } else
      return this.transformFrom(transform);
  };
  Modifier.prototype.setOpacity = function setOpacity(opacity, transition, callback) {
    if (transition || this._legacyStates.opacity) {
      if (!this._legacyStates.opacity) {
        this._legacyStates.opacity = new Transitionable(this._output.opacity);
      }
      if (!this._opacityGetter)
        this.opacityFrom(this._legacyStates.opacity);
      return this._legacyStates.opacity.set(opacity, transition, callback);
    } else
      return this.opacityFrom(opacity);
  };
  Modifier.prototype.setOrigin = function setOrigin(origin, transition, callback) {
    if (transition || this._legacyStates.origin) {
      if (!this._legacyStates.origin) {
        this._legacyStates.origin = new Transitionable(this._output.origin || [0, 0]);
      }
      if (!this._originGetter)
        this.originFrom(this._legacyStates.origin);
      this._legacyStates.origin.set(origin, transition, callback);
      return this;
    } else
      return this.originFrom(origin);
  };
  Modifier.prototype.setAlign = function setAlign(align, transition, callback) {
    if (transition || this._legacyStates.align) {
      if (!this._legacyStates.align) {
        this._legacyStates.align = new Transitionable(this._output.align || [0, 0]);
      }
      if (!this._alignGetter)
        this.alignFrom(this._legacyStates.align);
      this._legacyStates.align.set(align, transition, callback);
      return this;
    } else
      return this.alignFrom(align);
  };
  Modifier.prototype.setSize = function setSize(size, transition, callback) {
    if (size && (transition || this._legacyStates.size)) {
      if (!this._legacyStates.size) {
        this._legacyStates.size = new Transitionable(this._output.size || [0, 0]);
      }
      if (!this._sizeGetter)
        this.sizeFrom(this._legacyStates.size);
      this._legacyStates.size.set(size, transition, callback);
      return this;
    } else
      return this.sizeFrom(size);
  };
  Modifier.prototype.setProportions = function setProportions(proportions, transition, callback) {
    if (proportions && (transition || this._legacyStates.proportions)) {
      if (!this._legacyStates.proportions) {
        this._legacyStates.proportions = new Transitionable(this._output.proportions || [0, 0]);
      }
      if (!this._proportionGetter)
        this.proportionsFrom(this._legacyStates.proportions);
      this._legacyStates.proportions.set(proportions, transition, callback);
      return this;
    } else
      return this.proportionsFrom(proportions);
  };
  Modifier.prototype.halt = function halt() {
    if (this._legacyStates.transform)
      this._legacyStates.transform.halt();
    if (this._legacyStates.opacity)
      this._legacyStates.opacity.halt();
    if (this._legacyStates.origin)
      this._legacyStates.origin.halt();
    if (this._legacyStates.align)
      this._legacyStates.align.halt();
    if (this._legacyStates.size)
      this._legacyStates.size.halt();
    if (this._legacyStates.proportions)
      this._legacyStates.proportions.halt();
    this._transformGetter = null;
    this._opacityGetter = null;
    this._originGetter = null;
    this._alignGetter = null;
    this._sizeGetter = null;
    this._proportionGetter = null;
  };
  Modifier.prototype.getTransform = function getTransform() {
    return this._transformGetter();
  };
  Modifier.prototype.getFinalTransform = function getFinalTransform() {
    return this._legacyStates.transform ? this._legacyStates.transform.getFinal() : this._output.transform;
  };
  Modifier.prototype.getOpacity = function getOpacity() {
    return this._opacityGetter();
  };
  Modifier.prototype.getOrigin = function getOrigin() {
    return this._originGetter();
  };
  Modifier.prototype.getAlign = function getAlign() {
    return this._alignGetter();
  };
  Modifier.prototype.getSize = function getSize() {
    return this._sizeGetter ? this._sizeGetter() : this._output.size;
  };
  Modifier.prototype.getProportions = function getProportions() {
    return this._proportionGetter ? this._proportionGetter() : this._output.proportions;
  };
  function _update() {
    if (this._transformGetter)
      this._output.transform = this._transformGetter();
    if (this._opacityGetter)
      this._output.opacity = this._opacityGetter();
    if (this._originGetter)
      this._output.origin = this._originGetter();
    if (this._alignGetter)
      this._output.align = this._alignGetter();
    if (this._sizeGetter)
      this._output.size = this._sizeGetter();
    if (this._proportionGetter)
      this._output.proportions = this._proportionGetter();
  }
  Modifier.prototype.modify = function modify(target) {
    _update.call(this);
    this._output.target = target;
    return this._output;
  };
  module.exports = Modifier;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/events/index", ["npm:famous@0.3.5/events/EventArbiter", "npm:famous@0.3.5/events/EventFilter", "npm:famous@0.3.5/events/EventMapper"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    EventArbiter: require("npm:famous@0.3.5/events/EventArbiter"),
    EventFilter: require("npm:famous@0.3.5/events/EventFilter"),
    EventMapper: require("npm:famous@0.3.5/events/EventMapper")
  };
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/inputs/PinchSync", ["npm:famous@0.3.5/inputs/TwoFingerSync", "npm:famous@0.3.5/core/OptionsManager"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var TwoFingerSync = require("npm:famous@0.3.5/inputs/TwoFingerSync");
  var OptionsManager = require("npm:famous@0.3.5/core/OptionsManager");
  function PinchSync(options) {
    TwoFingerSync.call(this);
    this.options = Object.create(PinchSync.DEFAULT_OPTIONS);
    this._optionsManager = new OptionsManager(this.options);
    if (options)
      this.setOptions(options);
    this._displacement = 0;
    this._previousDistance = 0;
  }
  PinchSync.prototype = Object.create(TwoFingerSync.prototype);
  PinchSync.prototype.constructor = PinchSync;
  PinchSync.DEFAULT_OPTIONS = {scale: 1};
  PinchSync.prototype._startUpdate = function _startUpdate(event) {
    this._previousDistance = TwoFingerSync.calculateDistance(this.posA, this.posB);
    this._displacement = 0;
    this._eventOutput.emit('start', {
      count: event.touches.length,
      touches: [this.touchAId, this.touchBId],
      distance: this._dist,
      center: TwoFingerSync.calculateCenter(this.posA, this.posB)
    });
  };
  PinchSync.prototype._moveUpdate = function _moveUpdate(diffTime) {
    var currDist = TwoFingerSync.calculateDistance(this.posA, this.posB);
    var center = TwoFingerSync.calculateCenter(this.posA, this.posB);
    var scale = this.options.scale;
    var delta = scale * (currDist - this._previousDistance);
    var velocity = delta / diffTime;
    this._previousDistance = currDist;
    this._displacement += delta;
    this._eventOutput.emit('update', {
      delta: delta,
      velocity: velocity,
      distance: currDist,
      displacement: this._displacement,
      center: center,
      touches: [this.touchAId, this.touchBId]
    });
  };
  PinchSync.prototype.getOptions = function getOptions() {
    return this.options;
  };
  PinchSync.prototype.setOptions = function setOptions(options) {
    return this._optionsManager.setOptions(options);
  };
  module.exports = PinchSync;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/inputs/TouchSync", ["npm:famous@0.3.5/inputs/TouchTracker", "npm:famous@0.3.5/core/EventHandler", "npm:famous@0.3.5/core/OptionsManager"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var TouchTracker = require("npm:famous@0.3.5/inputs/TouchTracker");
  var EventHandler = require("npm:famous@0.3.5/core/EventHandler");
  var OptionsManager = require("npm:famous@0.3.5/core/OptionsManager");
  function TouchSync(options) {
    this.options = Object.create(TouchSync.DEFAULT_OPTIONS);
    this._optionsManager = new OptionsManager(this.options);
    if (options)
      this.setOptions(options);
    this._eventOutput = new EventHandler();
    this._touchTracker = new TouchTracker({touchLimit: this.options.touchLimit});
    EventHandler.setOutputHandler(this, this._eventOutput);
    EventHandler.setInputHandler(this, this._touchTracker);
    this._touchTracker.on('trackstart', _handleStart.bind(this));
    this._touchTracker.on('trackmove', _handleMove.bind(this));
    this._touchTracker.on('trackend', _handleEnd.bind(this));
    this._payload = {
      delta: null,
      position: null,
      velocity: null,
      clientX: undefined,
      clientY: undefined,
      count: 0,
      touch: undefined
    };
    this._position = null;
  }
  TouchSync.DEFAULT_OPTIONS = {
    direction: undefined,
    rails: false,
    touchLimit: 1,
    velocitySampleLength: 10,
    scale: 1
  };
  TouchSync.DIRECTION_X = 0;
  TouchSync.DIRECTION_Y = 1;
  var MINIMUM_TICK_TIME = 8;
  function _handleStart(data) {
    var velocity;
    var delta;
    if (this.options.direction !== undefined) {
      this._position = 0;
      velocity = 0;
      delta = 0;
    } else {
      this._position = [0, 0];
      velocity = [0, 0];
      delta = [0, 0];
    }
    var payload = this._payload;
    payload.delta = delta;
    payload.position = this._position;
    payload.velocity = velocity;
    payload.clientX = data.x;
    payload.clientY = data.y;
    payload.count = data.count;
    payload.touch = data.identifier;
    this._eventOutput.emit('start', payload);
  }
  function _handleMove(data) {
    var history = data.history;
    var currHistory = history[history.length - 1];
    var prevHistory = history[history.length - 2];
    var distantHistory = history[history.length - this.options.velocitySampleLength] ? history[history.length - this.options.velocitySampleLength] : history[history.length - 2];
    var distantTime = distantHistory.timestamp;
    var currTime = currHistory.timestamp;
    var diffX = currHistory.x - prevHistory.x;
    var diffY = currHistory.y - prevHistory.y;
    var velDiffX = currHistory.x - distantHistory.x;
    var velDiffY = currHistory.y - distantHistory.y;
    if (this.options.rails) {
      if (Math.abs(diffX) > Math.abs(diffY))
        diffY = 0;
      else
        diffX = 0;
      if (Math.abs(velDiffX) > Math.abs(velDiffY))
        velDiffY = 0;
      else
        velDiffX = 0;
    }
    var diffTime = Math.max(currTime - distantTime, MINIMUM_TICK_TIME);
    var velX = velDiffX / diffTime;
    var velY = velDiffY / diffTime;
    var scale = this.options.scale;
    var nextVel;
    var nextDelta;
    if (this.options.direction === TouchSync.DIRECTION_X) {
      nextDelta = scale * diffX;
      nextVel = scale * velX;
      this._position += nextDelta;
    } else if (this.options.direction === TouchSync.DIRECTION_Y) {
      nextDelta = scale * diffY;
      nextVel = scale * velY;
      this._position += nextDelta;
    } else {
      nextDelta = [scale * diffX, scale * diffY];
      nextVel = [scale * velX, scale * velY];
      this._position[0] += nextDelta[0];
      this._position[1] += nextDelta[1];
    }
    var payload = this._payload;
    payload.delta = nextDelta;
    payload.velocity = nextVel;
    payload.position = this._position;
    payload.clientX = data.x;
    payload.clientY = data.y;
    payload.count = data.count;
    payload.touch = data.identifier;
    this._eventOutput.emit('update', payload);
  }
  function _handleEnd(data) {
    this._payload.count = data.count;
    this._eventOutput.emit('end', this._payload);
  }
  TouchSync.prototype.setOptions = function setOptions(options) {
    return this._optionsManager.setOptions(options);
  };
  TouchSync.prototype.getOptions = function getOptions() {
    return this.options;
  };
  module.exports = TouchSync;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/math/Matrix", ["npm:famous@0.3.5/math/Vector"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var Vector = require("npm:famous@0.3.5/math/Vector");
  function Matrix(values) {
    this.values = values || [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    return this;
  }
  var _register = new Matrix();
  var _vectorRegister = new Vector();
  Matrix.prototype.get = function get() {
    return this.values;
  };
  Matrix.prototype.set = function set(values) {
    this.values = values;
  };
  Matrix.prototype.vectorMultiply = function vectorMultiply(v) {
    var M = this.get();
    var v0 = v.x;
    var v1 = v.y;
    var v2 = v.z;
    var M0 = M[0];
    var M1 = M[1];
    var M2 = M[2];
    var M00 = M0[0];
    var M01 = M0[1];
    var M02 = M0[2];
    var M10 = M1[0];
    var M11 = M1[1];
    var M12 = M1[2];
    var M20 = M2[0];
    var M21 = M2[1];
    var M22 = M2[2];
    return _vectorRegister.setXYZ(M00 * v0 + M01 * v1 + M02 * v2, M10 * v0 + M11 * v1 + M12 * v2, M20 * v0 + M21 * v1 + M22 * v2);
  };
  Matrix.prototype.multiply = function multiply(M2) {
    var M1 = this.get();
    var result = [[]];
    for (var i = 0; i < 3; i++) {
      result[i] = [];
      for (var j = 0; j < 3; j++) {
        var sum = 0;
        for (var k = 0; k < 3; k++) {
          sum += M1[i][k] * M2[k][j];
        }
        result[i][j] = sum;
      }
    }
    return _register.set(result);
  };
  Matrix.prototype.transpose = function transpose() {
    var result = [[], [], []];
    var M = this.get();
    for (var row = 0; row < 3; row++) {
      for (var col = 0; col < 3; col++) {
        result[row][col] = M[col][row];
      }
    }
    return _register.set(result);
  };
  Matrix.prototype.clone = function clone() {
    var values = this.get();
    var M = [];
    for (var row = 0; row < 3; row++)
      M[row] = values[row].slice();
    return new Matrix(M);
  };
  module.exports = Matrix;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/modifiers/index", ["npm:famous@0.3.5/modifiers/Draggable", "npm:famous@0.3.5/modifiers/Fader", "npm:famous@0.3.5/modifiers/ModifierChain", "npm:famous@0.3.5/modifiers/StateModifier"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    Draggable: require("npm:famous@0.3.5/modifiers/Draggable"),
    Fader: require("npm:famous@0.3.5/modifiers/Fader"),
    ModifierChain: require("npm:famous@0.3.5/modifiers/ModifierChain"),
    StateModifier: require("npm:famous@0.3.5/modifiers/StateModifier")
  };
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/physics/bodies/Particle", ["npm:famous@0.3.5/math/Vector", "npm:famous@0.3.5/core/Transform", "npm:famous@0.3.5/core/EventHandler", "npm:famous@0.3.5/physics/integrators/SymplecticEuler"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var Vector = require("npm:famous@0.3.5/math/Vector");
  var Transform = require("npm:famous@0.3.5/core/Transform");
  var EventHandler = require("npm:famous@0.3.5/core/EventHandler");
  var Integrator = require("npm:famous@0.3.5/physics/integrators/SymplecticEuler");
  function Particle(options) {
    options = options || {};
    var defaults = Particle.DEFAULT_OPTIONS;
    this.position = new Vector();
    this.velocity = new Vector();
    this.force = new Vector();
    this._engine = null;
    this._isSleeping = true;
    this._eventOutput = null;
    this.mass = options.mass !== undefined ? options.mass : defaults.mass;
    this.inverseMass = 1 / this.mass;
    this.setPosition(options.position || defaults.position);
    this.setVelocity(options.velocity || defaults.velocity);
    this.force.set(options.force || [0, 0, 0]);
    this.transform = Transform.identity.slice();
    this._spec = {
      size: [true, true],
      target: {
        transform: this.transform,
        origin: [0.5, 0.5],
        target: null
      }
    };
  }
  Particle.DEFAULT_OPTIONS = {
    position: [0, 0, 0],
    velocity: [0, 0, 0],
    mass: 1
  };
  var _events = {
    start: 'start',
    update: 'update',
    end: 'end'
  };
  var now = Date.now;
  Particle.prototype.isBody = false;
  Particle.prototype.isActive = function isActive() {
    return !this._isSleeping;
  };
  Particle.prototype.sleep = function sleep() {
    if (this._isSleeping)
      return ;
    this.emit(_events.end, this);
    this._isSleeping = true;
  };
  Particle.prototype.wake = function wake() {
    if (!this._isSleeping)
      return ;
    this.emit(_events.start, this);
    this._isSleeping = false;
    this._prevTime = now();
    if (this._engine)
      this._engine.wake();
  };
  Particle.prototype.setPosition = function setPosition(position) {
    this.position.set(position);
  };
  Particle.prototype.setPosition1D = function setPosition1D(x) {
    this.position.x = x;
  };
  Particle.prototype.getPosition = function getPosition() {
    this._engine.step();
    return this.position.get();
  };
  Particle.prototype.getPosition1D = function getPosition1D() {
    this._engine.step();
    return this.position.x;
  };
  Particle.prototype.setVelocity = function setVelocity(velocity) {
    this.velocity.set(velocity);
    if (!(velocity[0] === 0 && velocity[1] === 0 && velocity[2] === 0))
      this.wake();
  };
  Particle.prototype.setVelocity1D = function setVelocity1D(x) {
    this.velocity.x = x;
    if (x !== 0)
      this.wake();
  };
  Particle.prototype.getVelocity = function getVelocity() {
    return this.velocity.get();
  };
  Particle.prototype.setForce = function setForce(force) {
    this.force.set(force);
    this.wake();
  };
  Particle.prototype.getVelocity1D = function getVelocity1D() {
    return this.velocity.x;
  };
  Particle.prototype.setMass = function setMass(mass) {
    this.mass = mass;
    this.inverseMass = 1 / mass;
  };
  Particle.prototype.getMass = function getMass() {
    return this.mass;
  };
  Particle.prototype.reset = function reset(position, velocity) {
    this.setPosition(position || [0, 0, 0]);
    this.setVelocity(velocity || [0, 0, 0]);
  };
  Particle.prototype.applyForce = function applyForce(force) {
    if (force.isZero())
      return ;
    this.force.add(force).put(this.force);
    this.wake();
  };
  Particle.prototype.applyImpulse = function applyImpulse(impulse) {
    if (impulse.isZero())
      return ;
    var velocity = this.velocity;
    velocity.add(impulse.mult(this.inverseMass)).put(velocity);
  };
  Particle.prototype.integrateVelocity = function integrateVelocity(dt) {
    Integrator.integrateVelocity(this, dt);
  };
  Particle.prototype.integratePosition = function integratePosition(dt) {
    Integrator.integratePosition(this, dt);
  };
  Particle.prototype._integrate = function _integrate(dt) {
    this.integrateVelocity(dt);
    this.integratePosition(dt);
  };
  Particle.prototype.getEnergy = function getEnergy() {
    return 0.5 * this.mass * this.velocity.normSquared();
  };
  Particle.prototype.getTransform = function getTransform() {
    this._engine.step();
    var position = this.position;
    var transform = this.transform;
    transform[12] = position.x;
    transform[13] = position.y;
    transform[14] = position.z;
    return transform;
  };
  Particle.prototype.modify = function modify(target) {
    var _spec = this._spec.target;
    _spec.transform = this.getTransform();
    _spec.target = target;
    return this._spec;
  };
  function _createEventOutput() {
    this._eventOutput = new EventHandler();
    this._eventOutput.bindThis(this);
    EventHandler.setOutputHandler(this, this._eventOutput);
  }
  Particle.prototype.emit = function emit(type, data) {
    if (!this._eventOutput)
      return ;
    this._eventOutput.emit(type, data);
  };
  Particle.prototype.on = function on() {
    _createEventOutput.call(this);
    return this.on.apply(this, arguments);
  };
  Particle.prototype.removeListener = function removeListener() {
    _createEventOutput.call(this);
    return this.removeListener.apply(this, arguments);
  };
  Particle.prototype.pipe = function pipe() {
    _createEventOutput.call(this);
    return this.pipe.apply(this, arguments);
  };
  Particle.prototype.unpipe = function unpipe() {
    _createEventOutput.call(this);
    return this.unpipe.apply(this, arguments);
  };
  module.exports = Particle;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/physics/constraints/Collision", ["npm:famous@0.3.5/physics/constraints/Constraint", "npm:famous@0.3.5/math/Vector"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var Constraint = require("npm:famous@0.3.5/physics/constraints/Constraint");
  var Vector = require("npm:famous@0.3.5/math/Vector");
  function Collision(options) {
    this.options = Object.create(Collision.DEFAULT_OPTIONS);
    if (options)
      this.setOptions(options);
    this.normal = new Vector();
    this.pDiff = new Vector();
    this.vDiff = new Vector();
    this.impulse1 = new Vector();
    this.impulse2 = new Vector();
    Constraint.call(this);
  }
  Collision.prototype = Object.create(Constraint.prototype);
  Collision.prototype.constructor = Collision;
  Collision.DEFAULT_OPTIONS = {
    restitution: 0.5,
    drift: 0.5,
    slop: 0
  };
  function _normalVelocity(particle1, particle2) {
    return particle1.velocity.dot(particle2.velocity);
  }
  Collision.prototype.setOptions = function setOptions(options) {
    for (var key in options)
      this.options[key] = options[key];
  };
  Collision.prototype.applyConstraint = function applyConstraint(targets, source, dt) {
    if (source === undefined)
      return ;
    var v1 = source.velocity;
    var p1 = source.position;
    var w1 = source.inverseMass;
    var r1 = source.radius;
    var options = this.options;
    var drift = options.drift;
    var slop = -options.slop;
    var restitution = options.restitution;
    var n = this.normal;
    var pDiff = this.pDiff;
    var vDiff = this.vDiff;
    var impulse1 = this.impulse1;
    var impulse2 = this.impulse2;
    for (var i = 0; i < targets.length; i++) {
      var target = targets[i];
      if (target === source)
        continue;
      var v2 = target.velocity;
      var p2 = target.position;
      var w2 = target.inverseMass;
      var r2 = target.radius;
      pDiff.set(p2.sub(p1));
      vDiff.set(v2.sub(v1));
      var dist = pDiff.norm();
      var overlap = dist - (r1 + r2);
      var effMass = 1 / (w1 + w2);
      var gamma = 0;
      if (overlap < 0) {
        n.set(pDiff.normalize());
        if (this._eventOutput) {
          var collisionData = {
            target: target,
            source: source,
            overlap: overlap,
            normal: n
          };
          this._eventOutput.emit('preCollision', collisionData);
          this._eventOutput.emit('collision', collisionData);
        }
        var lambda = overlap <= slop ? ((1 + restitution) * n.dot(vDiff) + drift / dt * (overlap - slop)) / (gamma + dt / effMass) : (1 + restitution) * n.dot(vDiff) / (gamma + dt / effMass);
        n.mult(dt * lambda).put(impulse1);
        impulse1.mult(-1).put(impulse2);
        source.applyImpulse(impulse1);
        target.applyImpulse(impulse2);
        if (this._eventOutput)
          this._eventOutput.emit('postCollision', collisionData);
      }
    }
  };
  module.exports = Collision;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/physics/forces/Drag", ["npm:famous@0.3.5/physics/forces/Force"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var Force = require("npm:famous@0.3.5/physics/forces/Force");
  function Drag(options) {
    this.options = Object.create(this.constructor.DEFAULT_OPTIONS);
    if (options)
      this.setOptions(options);
    Force.call(this);
  }
  Drag.prototype = Object.create(Force.prototype);
  Drag.prototype.constructor = Drag;
  Drag.FORCE_FUNCTIONS = {
    LINEAR: function(velocity) {
      return velocity;
    },
    QUADRATIC: function(velocity) {
      return velocity.mult(velocity.norm());
    }
  };
  Drag.DEFAULT_OPTIONS = {
    strength: 0.01,
    forceFunction: Drag.FORCE_FUNCTIONS.LINEAR
  };
  Drag.prototype.applyForce = function applyForce(targets) {
    var strength = this.options.strength;
    var forceFunction = this.options.forceFunction;
    var force = this.force;
    var index;
    var particle;
    for (index = 0; index < targets.length; index++) {
      particle = targets[index];
      forceFunction(particle.velocity).mult(-strength).put(force);
      particle.applyForce(force);
    }
  };
  Drag.prototype.setOptions = function setOptions(options) {
    for (var key in options)
      this.options[key] = options[key];
  };
  module.exports = Drag;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/physics/forces/RotationalSpring", ["npm:famous@0.3.5/physics/forces/Force", "npm:famous@0.3.5/physics/forces/Spring", "npm:famous@0.3.5/math/Quaternion"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var Force = require("npm:famous@0.3.5/physics/forces/Force");
  var Spring = require("npm:famous@0.3.5/physics/forces/Spring");
  var Quaternion = require("npm:famous@0.3.5/math/Quaternion");
  function RotationalSpring(options) {
    Spring.call(this, options);
  }
  RotationalSpring.prototype = Object.create(Spring.prototype);
  RotationalSpring.prototype.constructor = RotationalSpring;
  RotationalSpring.DEFAULT_OPTIONS = Spring.DEFAULT_OPTIONS;
  RotationalSpring.FORCE_FUNCTIONS = Spring.FORCE_FUNCTIONS;
  var pi = Math.PI;
  function _calcStiffness() {
    var options = this.options;
    options.stiffness = Math.pow(2 * pi / options.period, 2);
  }
  function _calcDamping() {
    var options = this.options;
    options.damping = 4 * pi * options.dampingRatio / options.period;
  }
  function _init() {
    _calcStiffness.call(this);
    _calcDamping.call(this);
  }
  RotationalSpring.prototype.setOptions = function setOptions(options) {
    if (options.anchor !== undefined) {
      if (options.anchor instanceof Quaternion)
        this.options.anchor = options.anchor;
      if (options.anchor instanceof Array)
        this.options.anchor = new Quaternion(options.anchor);
    }
    if (options.period !== undefined) {
      this.options.period = options.period;
    }
    if (options.dampingRatio !== undefined)
      this.options.dampingRatio = options.dampingRatio;
    if (options.length !== undefined)
      this.options.length = options.length;
    if (options.forceFunction !== undefined)
      this.options.forceFunction = options.forceFunction;
    if (options.maxLength !== undefined)
      this.options.maxLength = options.maxLength;
    _init.call(this);
    Force.prototype.setOptions.call(this, options);
  };
  RotationalSpring.prototype.applyForce = function applyForce(targets) {
    var force = this.force;
    var options = this.options;
    var disp = this.disp;
    var stiffness = options.stiffness;
    var damping = options.damping;
    var restLength = options.length;
    var anchor = options.anchor;
    var forceFunction = options.forceFunction;
    var maxLength = options.maxLength;
    var i;
    var target;
    var dist;
    var m;
    for (i = 0; i < targets.length; i++) {
      target = targets[i];
      disp.set(anchor.sub(target.orientation));
      dist = disp.norm() - restLength;
      if (dist === 0)
        return ;
      m = target.mass;
      stiffness *= m;
      damping *= m;
      force.set(disp.normalize(stiffness * forceFunction(dist, maxLength)));
      if (damping)
        force.add(target.angularVelocity.mult(-damping)).put(force);
      target.applyTorque(force);
    }
  };
  RotationalSpring.prototype.getEnergy = function getEnergy(targets) {
    var options = this.options;
    var restLength = options.length;
    var anchor = options.anchor;
    var strength = options.stiffness;
    var energy = 0;
    for (var i = 0; i < targets.length; i++) {
      var target = targets[i];
      var dist = anchor.sub(target.orientation).norm() - restLength;
      energy += 0.5 * strength * dist * dist;
    }
    return energy;
  };
  module.exports = RotationalSpring;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/surfaces/index", ["npm:famous@0.3.5/surfaces/CanvasSurface", "npm:famous@0.3.5/surfaces/ContainerSurface", "npm:famous@0.3.5/surfaces/FormContainerSurface", "npm:famous@0.3.5/surfaces/ImageSurface", "npm:famous@0.3.5/surfaces/InputSurface", "npm:famous@0.3.5/surfaces/SubmitInputSurface", "npm:famous@0.3.5/surfaces/TextareaSurface", "npm:famous@0.3.5/surfaces/VideoSurface"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    CanvasSurface: require("npm:famous@0.3.5/surfaces/CanvasSurface"),
    ContainerSurface: require("npm:famous@0.3.5/surfaces/ContainerSurface"),
    FormContainerSurface: require("npm:famous@0.3.5/surfaces/FormContainerSurface"),
    ImageSurface: require("npm:famous@0.3.5/surfaces/ImageSurface"),
    InputSurface: require("npm:famous@0.3.5/surfaces/InputSurface"),
    SubmitInputSurface: require("npm:famous@0.3.5/surfaces/SubmitInputSurface"),
    TextareaSurface: require("npm:famous@0.3.5/surfaces/TextareaSurface"),
    VideoSurface: require("npm:famous@0.3.5/surfaces/VideoSurface")
  };
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/transitions/index", ["npm:famous@0.3.5/transitions/CachedMap", "npm:famous@0.3.5/transitions/Easing", "npm:famous@0.3.5/transitions/MultipleTransition", "npm:famous@0.3.5/transitions/SnapTransition", "npm:famous@0.3.5/transitions/SpringTransition", "npm:famous@0.3.5/transitions/Transitionable", "npm:famous@0.3.5/transitions/TransitionableTransform", "npm:famous@0.3.5/transitions/TweenTransition", "npm:famous@0.3.5/transitions/WallTransition"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    CachedMap: require("npm:famous@0.3.5/transitions/CachedMap"),
    Easing: require("npm:famous@0.3.5/transitions/Easing"),
    MultipleTransition: require("npm:famous@0.3.5/transitions/MultipleTransition"),
    SnapTransition: require("npm:famous@0.3.5/transitions/SnapTransition"),
    SpringTransition: require("npm:famous@0.3.5/transitions/SpringTransition"),
    Transitionable: require("npm:famous@0.3.5/transitions/Transitionable"),
    TransitionableTransform: require("npm:famous@0.3.5/transitions/TransitionableTransform"),
    TweenTransition: require("npm:famous@0.3.5/transitions/TweenTransition"),
    WallTransition: require("npm:famous@0.3.5/transitions/WallTransition")
  };
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/utilities/index", ["npm:famous@0.3.5/utilities/KeyCodes", "npm:famous@0.3.5/utilities/Timer", "npm:famous@0.3.5/utilities/Utility"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    KeyCodes: require("npm:famous@0.3.5/utilities/KeyCodes"),
    Timer: require("npm:famous@0.3.5/utilities/Timer"),
    Utility: require("npm:famous@0.3.5/utilities/Utility")
  };
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/views/Deck", ["npm:famous@0.3.5/core/Transform", "npm:famous@0.3.5/core/OptionsManager", "npm:famous@0.3.5/transitions/Transitionable", "npm:famous@0.3.5/utilities/Utility", "npm:famous@0.3.5/views/SequentialLayout"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var Transform = require("npm:famous@0.3.5/core/Transform");
  var OptionsManager = require("npm:famous@0.3.5/core/OptionsManager");
  var Transitionable = require("npm:famous@0.3.5/transitions/Transitionable");
  var Utility = require("npm:famous@0.3.5/utilities/Utility");
  var SequentialLayout = require("npm:famous@0.3.5/views/SequentialLayout");
  function Deck(options) {
    SequentialLayout.apply(this, arguments);
    this.state = new Transitionable(0);
    this._isOpen = false;
    this.setOutputFunction(function(input, offset, index) {
      var state = _getState.call(this);
      var positionMatrix = this.options.direction === Utility.Direction.X ? Transform.translate(state * offset, 0, 0.001 * (state - 1) * offset) : Transform.translate(0, state * offset, 0.001 * (state - 1) * offset);
      var output = input.render();
      if (this.options.stackRotation) {
        var amount = this.options.stackRotation * index * (1 - state);
        output = {
          transform: Transform.rotateZ(amount),
          origin: [0.5, 0.5],
          target: output
        };
      }
      return {
        transform: positionMatrix,
        size: input.getSize(),
        target: output
      };
    });
  }
  Deck.prototype = Object.create(SequentialLayout.prototype);
  Deck.prototype.constructor = Deck;
  Deck.DEFAULT_OPTIONS = OptionsManager.patch(SequentialLayout.DEFAULT_OPTIONS, {
    transition: {
      curve: 'easeOutBounce',
      duration: 500
    },
    stackRotation: 0
  });
  Deck.prototype.getSize = function getSize() {
    var originalSize = SequentialLayout.prototype.getSize.apply(this, arguments);
    var firstSize = this._items ? this._items.get().getSize() : [0, 0];
    if (!firstSize)
      firstSize = [0, 0];
    var state = _getState.call(this);
    var invState = 1 - state;
    return [firstSize[0] * invState + originalSize[0] * state, firstSize[1] * invState + originalSize[1] * state];
  };
  function _getState(returnFinal) {
    if (returnFinal)
      return this._isOpen ? 1 : 0;
    else
      return this.state.get();
  }
  function _setState(pos, transition, callback) {
    this.state.halt();
    this.state.set(pos, transition, callback);
  }
  Deck.prototype.isOpen = function isOpen() {
    return this._isOpen;
  };
  Deck.prototype.open = function open(callback) {
    this._isOpen = true;
    _setState.call(this, 1, this.options.transition, callback);
  };
  Deck.prototype.close = function close(callback) {
    this._isOpen = false;
    _setState.call(this, 0, this.options.transition, callback);
  };
  Deck.prototype.toggle = function toggle(callback) {
    if (this._isOpen)
      this.close(callback);
    else
      this.open(callback);
  };
  module.exports = Deck;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/views/EdgeSwapper", ["npm:famous@0.3.5/transitions/CachedMap", "npm:famous@0.3.5/core/Entity", "npm:famous@0.3.5/core/EventHandler", "npm:famous@0.3.5/core/Transform", "npm:famous@0.3.5/views/RenderController"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var CachedMap = require("npm:famous@0.3.5/transitions/CachedMap");
  var Entity = require("npm:famous@0.3.5/core/Entity");
  var EventHandler = require("npm:famous@0.3.5/core/EventHandler");
  var Transform = require("npm:famous@0.3.5/core/Transform");
  var RenderController = require("npm:famous@0.3.5/views/RenderController");
  function EdgeSwapper(options) {
    this._currentTarget = null;
    this._size = [undefined, undefined];
    this._controller = new RenderController(options);
    this._controller.inTransformFrom(CachedMap.create(_transformMap.bind(this, 0.0001)));
    this._controller.outTransformFrom(CachedMap.create(_transformMap.bind(this, -0.0001)));
    this._eventInput = new EventHandler();
    EventHandler.setInputHandler(this, this._eventInput);
    this._entityId = Entity.register(this);
    if (options)
      this.setOptions(options);
  }
  function _transformMap(zMax, progress) {
    return Transform.translate(this._size[0] * (1 - progress), 0, zMax * (1 - progress));
  }
  EdgeSwapper.prototype.show = function show(content) {
    if (this._currentTarget)
      this._eventInput.unpipe(this._currentTarget);
    this._currentTarget = content;
    if (this._currentTarget && this._currentTarget.trigger)
      this._eventInput.pipe(this._currentTarget);
    this._controller.show.apply(this._controller, arguments);
  };
  EdgeSwapper.prototype.setOptions = function setOptions(options) {
    this._controller.setOptions(options);
  };
  EdgeSwapper.prototype.render = function render() {
    return this._entityId;
  };
  EdgeSwapper.prototype.commit = function commit(context) {
    this._size[0] = context.size[0];
    this._size[1] = context.size[1];
    return {
      transform: context.transform,
      opacity: context.opacity,
      origin: context.origin,
      size: context.size,
      target: this._controller.render()
    };
  };
  module.exports = EdgeSwapper;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/views/Scrollview", ["npm:famous@0.3.5/physics/PhysicsEngine", "npm:famous@0.3.5/physics/bodies/Particle", "npm:famous@0.3.5/physics/forces/Drag", "npm:famous@0.3.5/physics/forces/Spring", "npm:famous@0.3.5/core/EventHandler", "npm:famous@0.3.5/core/OptionsManager", "npm:famous@0.3.5/core/ViewSequence", "npm:famous@0.3.5/views/Scroller", "npm:famous@0.3.5/utilities/Utility", "npm:famous@0.3.5/inputs/GenericSync", "npm:famous@0.3.5/inputs/ScrollSync", "npm:famous@0.3.5/inputs/TouchSync"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var PhysicsEngine = require("npm:famous@0.3.5/physics/PhysicsEngine");
  var Particle = require("npm:famous@0.3.5/physics/bodies/Particle");
  var Drag = require("npm:famous@0.3.5/physics/forces/Drag");
  var Spring = require("npm:famous@0.3.5/physics/forces/Spring");
  var EventHandler = require("npm:famous@0.3.5/core/EventHandler");
  var OptionsManager = require("npm:famous@0.3.5/core/OptionsManager");
  var ViewSequence = require("npm:famous@0.3.5/core/ViewSequence");
  var Scroller = require("npm:famous@0.3.5/views/Scroller");
  var Utility = require("npm:famous@0.3.5/utilities/Utility");
  var GenericSync = require("npm:famous@0.3.5/inputs/GenericSync");
  var ScrollSync = require("npm:famous@0.3.5/inputs/ScrollSync");
  var TouchSync = require("npm:famous@0.3.5/inputs/TouchSync");
  GenericSync.register({
    scroll: ScrollSync,
    touch: TouchSync
  });
  var TOLERANCE = 0.5;
  var SpringStates = {
    NONE: 0,
    EDGE: 1,
    PAGE: 2
  };
  var EdgeStates = {
    TOP: -1,
    NONE: 0,
    BOTTOM: 1
  };
  function Scrollview(options) {
    this.options = Object.create(Scrollview.DEFAULT_OPTIONS);
    this._optionsManager = new OptionsManager(this.options);
    this._scroller = new Scroller(this.options);
    this.sync = new GenericSync(['scroll', 'touch'], {
      direction: this.options.direction,
      scale: this.options.syncScale,
      rails: this.options.rails,
      preventDefault: this.options.preventDefault !== undefined ? this.options.preventDefault : this.options.direction !== Utility.Direction.Y
    });
    this._physicsEngine = new PhysicsEngine();
    this._particle = new Particle();
    this._physicsEngine.addBody(this._particle);
    this.spring = new Spring({
      anchor: [0, 0, 0],
      period: this.options.edgePeriod,
      dampingRatio: this.options.edgeDamp
    });
    this.drag = new Drag({
      forceFunction: Drag.FORCE_FUNCTIONS.QUADRATIC,
      strength: this.options.drag
    });
    this.friction = new Drag({
      forceFunction: Drag.FORCE_FUNCTIONS.LINEAR,
      strength: this.options.friction
    });
    this._node = null;
    this._touchCount = 0;
    this._springState = SpringStates.NONE;
    this._onEdge = EdgeStates.NONE;
    this._pageSpringPosition = 0;
    this._edgeSpringPosition = 0;
    this._touchVelocity = 0;
    this._earlyEnd = false;
    this._needsPaginationCheck = false;
    this._displacement = 0;
    this._totalShift = 0;
    this._cachedIndex = 0;
    this._scroller.positionFrom(this.getPosition.bind(this));
    this._eventInput = new EventHandler();
    this._eventOutput = new EventHandler();
    this._eventInput.pipe(this.sync);
    this.sync.pipe(this._eventInput);
    EventHandler.setInputHandler(this, this._eventInput);
    EventHandler.setOutputHandler(this, this._eventOutput);
    _bindEvents.call(this);
    if (options)
      this.setOptions(options);
  }
  Scrollview.DEFAULT_OPTIONS = {
    direction: Utility.Direction.Y,
    rails: true,
    friction: 0.005,
    drag: 0.0001,
    edgeGrip: 0.2,
    edgePeriod: 300,
    edgeDamp: 1,
    margin: 1000,
    paginated: false,
    pagePeriod: 500,
    pageDamp: 0.8,
    pageStopSpeed: 10,
    pageSwitchSpeed: 0.5,
    speedLimit: 5,
    groupScroll: false,
    syncScale: 1
  };
  function _handleStart(event) {
    this._touchCount = event.count;
    if (event.count === undefined)
      this._touchCount = 1;
    _detachAgents.call(this);
    this.setVelocity(0);
    this._touchVelocity = 0;
    this._earlyEnd = false;
  }
  function _handleMove(event) {
    var velocity = -event.velocity;
    var delta = -event.delta;
    if (this._onEdge !== EdgeStates.NONE && event.slip) {
      if (velocity < 0 && this._onEdge === EdgeStates.TOP || velocity > 0 && this._onEdge === EdgeStates.BOTTOM) {
        if (!this._earlyEnd) {
          _handleEnd.call(this, event);
          this._earlyEnd = true;
        }
      } else if (this._earlyEnd && Math.abs(velocity) > Math.abs(this.getVelocity())) {
        _handleStart.call(this, event);
      }
    }
    if (this._earlyEnd)
      return ;
    this._touchVelocity = velocity;
    if (event.slip) {
      var speedLimit = this.options.speedLimit;
      if (velocity < -speedLimit)
        velocity = -speedLimit;
      else if (velocity > speedLimit)
        velocity = speedLimit;
      this.setVelocity(velocity);
      var deltaLimit = speedLimit * 16;
      if (delta > deltaLimit)
        delta = deltaLimit;
      else if (delta < -deltaLimit)
        delta = -deltaLimit;
    }
    this.setPosition(this.getPosition() + delta);
    this._displacement += delta;
    if (this._springState === SpringStates.NONE)
      _normalizeState.call(this);
  }
  function _handleEnd(event) {
    this._touchCount = event.count || 0;
    if (!this._touchCount) {
      _detachAgents.call(this);
      if (this._onEdge !== EdgeStates.NONE)
        _setSpring.call(this, this._edgeSpringPosition, SpringStates.EDGE);
      _attachAgents.call(this);
      var velocity = -event.velocity;
      var speedLimit = this.options.speedLimit;
      if (event.slip)
        speedLimit *= this.options.edgeGrip;
      if (velocity < -speedLimit)
        velocity = -speedLimit;
      else if (velocity > speedLimit)
        velocity = speedLimit;
      this.setVelocity(velocity);
      this._touchVelocity = 0;
      this._needsPaginationCheck = true;
    }
  }
  function _bindEvents() {
    this._eventInput.bindThis(this);
    this._eventInput.on('start', _handleStart);
    this._eventInput.on('update', _handleMove);
    this._eventInput.on('end', _handleEnd);
    this._eventInput.on('resize', function() {
      this._node._.calculateSize();
    }.bind(this));
    this._scroller.on('onEdge', function(data) {
      this._edgeSpringPosition = data.position;
      _handleEdge.call(this, this._scroller.onEdge());
      this._eventOutput.emit('onEdge');
    }.bind(this));
    this._scroller.on('offEdge', function() {
      this.sync.setOptions({scale: this.options.syncScale});
      this._onEdge = this._scroller.onEdge();
      this._eventOutput.emit('offEdge');
    }.bind(this));
    this._particle.on('update', function(particle) {
      if (this._springState === SpringStates.NONE)
        _normalizeState.call(this);
      this._displacement = particle.position.x - this._totalShift;
    }.bind(this));
    this._particle.on('end', function() {
      if (!this.options.paginated || this.options.paginated && this._springState !== SpringStates.NONE)
        this._eventOutput.emit('settle');
    }.bind(this));
  }
  function _attachAgents() {
    if (this._springState)
      this._physicsEngine.attach([this.spring], this._particle);
    else
      this._physicsEngine.attach([this.drag, this.friction], this._particle);
  }
  function _detachAgents() {
    this._springState = SpringStates.NONE;
    this._physicsEngine.detachAll();
  }
  function _nodeSizeForDirection(node) {
    var direction = this.options.direction;
    var nodeSize = node.getSize();
    return !nodeSize ? this._scroller.getSize()[direction] : nodeSize[direction];
  }
  function _handleEdge(edge) {
    this.sync.setOptions({scale: this.options.edgeGrip});
    this._onEdge = edge;
    if (!this._touchCount && this._springState !== SpringStates.EDGE) {
      _setSpring.call(this, this._edgeSpringPosition, SpringStates.EDGE);
    }
    if (this._springState && Math.abs(this.getVelocity()) < 0.001) {
      _detachAgents.call(this);
      _attachAgents.call(this);
    }
  }
  function _handlePagination() {
    if (this._touchCount)
      return ;
    if (this._springState === SpringStates.EDGE)
      return ;
    var velocity = this.getVelocity();
    if (Math.abs(velocity) >= this.options.pageStopSpeed)
      return ;
    var position = this.getPosition();
    var velocitySwitch = Math.abs(velocity) > this.options.pageSwitchSpeed;
    var nodeSize = _nodeSizeForDirection.call(this, this._node);
    var positionNext = position > 0.5 * nodeSize;
    var positionPrev = position < 0.5 * nodeSize;
    var velocityNext = velocity > 0;
    var velocityPrev = velocity < 0;
    this._needsPaginationCheck = false;
    if (positionNext && !velocitySwitch || velocitySwitch && velocityNext) {
      this.goToNextPage();
    } else if (velocitySwitch && velocityPrev) {
      this.goToPreviousPage();
    } else
      _setSpring.call(this, 0, SpringStates.PAGE);
  }
  function _setSpring(position, springState) {
    var springOptions;
    if (springState === SpringStates.EDGE) {
      this._edgeSpringPosition = position;
      springOptions = {
        anchor: [this._edgeSpringPosition, 0, 0],
        period: this.options.edgePeriod,
        dampingRatio: this.options.edgeDamp
      };
    } else if (springState === SpringStates.PAGE) {
      this._pageSpringPosition = position;
      springOptions = {
        anchor: [this._pageSpringPosition, 0, 0],
        period: this.options.pagePeriod,
        dampingRatio: this.options.pageDamp
      };
    }
    this.spring.setOptions(springOptions);
    if (springState && !this._springState) {
      _detachAgents.call(this);
      this._springState = springState;
      _attachAgents.call(this);
    }
    this._springState = springState;
  }
  function _normalizeState() {
    var offset = 0;
    var position = this.getPosition();
    position += (position < 0 ? -0.5 : 0.5) >> 0;
    var nodeSize = _nodeSizeForDirection.call(this, this._node);
    var nextNode = this._node.getNext();
    while (offset + position >= nodeSize && nextNode) {
      offset -= nodeSize;
      this._scroller.sequenceFrom(nextNode);
      this._node = nextNode;
      nextNode = this._node.getNext();
      nodeSize = _nodeSizeForDirection.call(this, this._node);
    }
    var previousNode = this._node.getPrevious();
    var previousNodeSize;
    while (offset + position <= 0 && previousNode) {
      previousNodeSize = _nodeSizeForDirection.call(this, previousNode);
      this._scroller.sequenceFrom(previousNode);
      this._node = previousNode;
      offset += previousNodeSize;
      previousNode = this._node.getPrevious();
    }
    if (offset)
      _shiftOrigin.call(this, offset);
    if (this._node) {
      if (this._node.index !== this._cachedIndex) {
        if (this.getPosition() < 0.5 * nodeSize) {
          this._cachedIndex = this._node.index;
          this._eventOutput.emit('pageChange', {
            direction: -1,
            index: this._cachedIndex
          });
        }
      } else {
        if (this.getPosition() > 0.5 * nodeSize) {
          this._cachedIndex = this._node.index + 1;
          this._eventOutput.emit('pageChange', {
            direction: 1,
            index: this._cachedIndex
          });
        }
      }
    }
  }
  function _shiftOrigin(amount) {
    this._edgeSpringPosition += amount;
    this._pageSpringPosition += amount;
    this.setPosition(this.getPosition() + amount);
    this._totalShift += amount;
    if (this._springState === SpringStates.EDGE) {
      this.spring.setOptions({anchor: [this._edgeSpringPosition, 0, 0]});
    } else if (this._springState === SpringStates.PAGE) {
      this.spring.setOptions({anchor: [this._pageSpringPosition, 0, 0]});
    }
  }
  Scrollview.prototype.getCurrentIndex = function getCurrentIndex() {
    return this._node.index;
  };
  Scrollview.prototype.goToPreviousPage = function goToPreviousPage() {
    if (!this._node || this._onEdge === EdgeStates.TOP)
      return null;
    if (this.getPosition() > 1 && this._springState === SpringStates.NONE) {
      _setSpring.call(this, 0, SpringStates.PAGE);
      return this._node;
    }
    var previousNode = this._node.getPrevious();
    if (previousNode) {
      var previousNodeSize = _nodeSizeForDirection.call(this, previousNode);
      this._scroller.sequenceFrom(previousNode);
      this._node = previousNode;
      _shiftOrigin.call(this, previousNodeSize);
      _setSpring.call(this, 0, SpringStates.PAGE);
    }
    return previousNode;
  };
  Scrollview.prototype.goToNextPage = function goToNextPage() {
    if (!this._node || this._onEdge === EdgeStates.BOTTOM)
      return null;
    var nextNode = this._node.getNext();
    if (nextNode) {
      var currentNodeSize = _nodeSizeForDirection.call(this, this._node);
      this._scroller.sequenceFrom(nextNode);
      this._node = nextNode;
      _shiftOrigin.call(this, -currentNodeSize);
      _setSpring.call(this, 0, SpringStates.PAGE);
    }
    return nextNode;
  };
  Scrollview.prototype.goToPage = function goToPage(index) {
    var currentIndex = this.getCurrentIndex();
    var i;
    if (currentIndex > index) {
      for (i = 0; i < currentIndex - index; i++)
        this.goToPreviousPage();
    }
    if (currentIndex < index) {
      for (i = 0; i < index - currentIndex; i++)
        this.goToNextPage();
    }
  };
  Scrollview.prototype.outputFrom = function outputFrom() {
    return this._scroller.outputFrom.apply(this._scroller, arguments);
  };
  Scrollview.prototype.getPosition = function getPosition() {
    return this._particle.getPosition1D();
  };
  Scrollview.prototype.getAbsolutePosition = function getAbsolutePosition() {
    return this._scroller.getCumulativeSize(this.getCurrentIndex())[this.options.direction] + this.getPosition();
  };
  Scrollview.prototype.getOffset = Scrollview.prototype.getPosition;
  Scrollview.prototype.setPosition = function setPosition(x) {
    this._particle.setPosition1D(x);
  };
  Scrollview.prototype.setOffset = Scrollview.prototype.setPosition;
  Scrollview.prototype.getVelocity = function getVelocity() {
    return this._touchCount ? this._touchVelocity : this._particle.getVelocity1D();
  };
  Scrollview.prototype.setVelocity = function setVelocity(v) {
    this._particle.setVelocity1D(v);
  };
  Scrollview.prototype.setOptions = function setOptions(options) {
    if (options.direction !== undefined) {
      if (options.direction === 'x')
        options.direction = Utility.Direction.X;
      else if (options.direction === 'y')
        options.direction = Utility.Direction.Y;
    }
    if (options.groupScroll !== this.options.groupScroll) {
      if (options.groupScroll)
        this.subscribe(this._scroller);
      else
        this.unsubscribe(this._scroller);
    }
    this._optionsManager.setOptions(options);
    this._scroller.setOptions(options);
    if (options.drag !== undefined)
      this.drag.setOptions({strength: this.options.drag});
    if (options.friction !== undefined)
      this.friction.setOptions({strength: this.options.friction});
    if (options.edgePeriod !== undefined || options.edgeDamp !== undefined) {
      this.spring.setOptions({
        period: this.options.edgePeriod,
        dampingRatio: this.options.edgeDamp
      });
    }
    if (options.rails || options.direction !== undefined || options.syncScale !== undefined || options.preventDefault) {
      this.sync.setOptions({
        rails: this.options.rails,
        direction: this.options.direction === Utility.Direction.X ? GenericSync.DIRECTION_X : GenericSync.DIRECTION_Y,
        scale: this.options.syncScale,
        preventDefault: this.options.preventDefault
      });
    }
  };
  Scrollview.prototype.sequenceFrom = function sequenceFrom(node) {
    if (node instanceof Array)
      node = new ViewSequence({
        array: node,
        trackSize: true
      });
    this._node = node;
    return this._scroller.sequenceFrom(node);
  };
  Scrollview.prototype.getSize = function getSize() {
    return this._scroller.getSize.apply(this._scroller, arguments);
  };
  Scrollview.prototype.render = function render() {
    if (this.options.paginated && this._needsPaginationCheck)
      _handlePagination.call(this);
    return this._scroller.render();
  };
  module.exports = Scrollview;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/widgets/TabBar", ["npm:famous@0.3.5/utilities/Utility", "npm:famous@0.3.5/core/View", "npm:famous@0.3.5/views/GridLayout", "npm:famous@0.3.5/widgets/ToggleButton"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var Utility = require("npm:famous@0.3.5/utilities/Utility");
  var View = require("npm:famous@0.3.5/core/View");
  var GridLayout = require("npm:famous@0.3.5/views/GridLayout");
  var ToggleButton = require("npm:famous@0.3.5/widgets/ToggleButton");
  function TabBar(options) {
    View.apply(this, arguments);
    this.layout = new GridLayout();
    this.buttons = [];
    this._buttonIds = {};
    this._buttonCallbacks = {};
    this.layout.sequenceFrom(this.buttons);
    this._add(this.layout);
    this._optionsManager.on('change', _updateOptions.bind(this));
  }
  TabBar.prototype = Object.create(View.prototype);
  TabBar.prototype.constructor = TabBar;
  TabBar.DEFAULT_OPTIONS = {
    sections: [],
    widget: ToggleButton,
    size: [undefined, 50],
    direction: Utility.Direction.X,
    buttons: {toggleMode: ToggleButton.ON}
  };
  function _updateOptions(data) {
    var id = data.id;
    var value = data.value;
    if (id === 'direction') {
      this.layout.setOptions({dimensions: _resolveGridDimensions.call(this.buttons.length, this.options.direction)});
    } else if (id === 'buttons') {
      for (var i in this.buttons) {
        this.buttons[i].setOptions(value);
      }
    } else if (id === 'sections') {
      for (var sectionId in this.options.sections) {
        this.defineSection(sectionId, this.options.sections[sectionId]);
      }
    }
  }
  function _resolveGridDimensions(count, direction) {
    if (direction === Utility.Direction.X)
      return [count, 1];
    else
      return [1, count];
  }
  TabBar.prototype.defineSection = function defineSection(id, content) {
    var button;
    var i = this._buttonIds[id];
    if (i === undefined) {
      i = this.buttons.length;
      this._buttonIds[id] = i;
      var widget = this.options.widget;
      button = new widget();
      this.buttons[i] = button;
      this.layout.setOptions({dimensions: _resolveGridDimensions(this.buttons.length, this.options.direction)});
    } else {
      button = this.buttons[i];
      button.unbind('select', this._buttonCallbacks[id]);
    }
    if (this.options.buttons)
      button.setOptions(this.options.buttons);
    button.setOptions(content);
    this._buttonCallbacks[id] = this.select.bind(this, id);
    button.on('select', this._buttonCallbacks[id]);
  };
  TabBar.prototype.select = function select(id) {
    var btn = this._buttonIds[id];
    if (this.buttons[btn] && this.buttons[btn].isSelected()) {
      this._eventOutput.emit('select', {id: id});
    } else if (this.buttons[btn]) {
      this.buttons[btn].select();
    }
    for (var i = 0; i < this.buttons.length; i++) {
      if (i !== btn)
        this.buttons[i].deselect();
    }
  };
  module.exports = TabBar;
  global.define = __define;
  return module.exports;
});



(function() {
function define(){};  define.amd = {};
System.register("github:IjzerenHein/famous-flex@0.2.0/src/LayoutNodeManager", ["github:IjzerenHein/famous-flex@0.2.0/src/LayoutContext", "github:IjzerenHein/famous-flex@0.2.0/src/LayoutUtility"], false, function(__require, __exports, __module) {
  return (function(require, exports, module) {
    var LayoutContext = require("github:IjzerenHein/famous-flex@0.2.0/src/LayoutContext");
    var LayoutUtility = require("github:IjzerenHein/famous-flex@0.2.0/src/LayoutUtility");
    var MAX_POOL_SIZE = 100;
    function LayoutNodeManager(LayoutNode, initLayoutNodeFn) {
      this.LayoutNode = LayoutNode;
      this._initLayoutNodeFn = initLayoutNodeFn;
      this._layoutCount = 0;
      this._context = new LayoutContext({
        next: _contextNext.bind(this),
        prev: _contextPrev.bind(this),
        get: _contextGet.bind(this),
        set: _contextSet.bind(this),
        resolveSize: _contextResolveSize.bind(this),
        size: [0, 0]
      });
      this._contextState = {};
      this._pool = {
        layoutNodes: {size: 0},
        resolveSize: [0, 0]
      };
    }
    LayoutNodeManager.prototype.prepareForLayout = function(viewSequence, nodesById, contextData) {
      var node = this._first;
      while (node) {
        node.reset();
        node = node._next;
      }
      var context = this._context;
      this._layoutCount++;
      this._nodesById = nodesById;
      this._trueSizeRequested = false;
      this._reevalTrueSize = contextData.reevalTrueSize || !context.size || (context.size[0] !== contextData.size[0]) || (context.size[1] !== contextData.size[1]);
      var contextState = this._contextState;
      contextState.startSequence = viewSequence;
      contextState.nextSequence = viewSequence;
      contextState.prevSequence = viewSequence;
      contextState.start = undefined;
      contextState.nextGetIndex = 0;
      contextState.prevGetIndex = 0;
      contextState.nextSetIndex = 0;
      contextState.prevSetIndex = 0;
      contextState.addCount = 0;
      contextState.removeCount = 0;
      context.size[0] = contextData.size[0];
      context.size[1] = contextData.size[1];
      context.direction = contextData.direction;
      context.reverse = contextData.reverse;
      context.alignment = contextData.reverse ? 1 : 0;
      context.scrollOffset = contextData.scrollOffset || 0;
      context.scrollStart = contextData.scrollStart || 0;
      context.scrollEnd = contextData.scrollEnd || context.size[context.direction];
      return context;
    };
    LayoutNodeManager.prototype.removeNonInvalidatedNodes = function(removeSpec) {
      var node = this._first;
      while (node) {
        if (!node._invalidated && !node._removing) {
          node.remove(removeSpec);
        }
        node = node._next;
      }
    };
    LayoutNodeManager.prototype.removeVirtualViewSequenceNodes = function() {
      if (this._contextState.startSequence && this._contextState.startSequence.cleanup) {
        this._contextState.startSequence.cleanup();
      }
    };
    LayoutNodeManager.prototype.buildSpecAndDestroyUnrenderedNodes = function(translate) {
      var specs = [];
      var result = {
        specs: specs,
        modified: false
      };
      var node = this._first;
      while (node) {
        var modified = node._specModified;
        var spec = node.getSpec();
        if (spec.removed) {
          var destroyNode = node;
          node = node._next;
          _destroyNode.call(this, destroyNode);
          result.modified = true;
        } else {
          if (modified) {
            if (spec.transform && translate) {
              spec.transform[12] += translate[0];
              spec.transform[13] += translate[1];
              spec.transform[14] += translate[2];
              spec.transform[12] = Math.round(spec.transform[12] * 100000) / 100000;
              spec.transform[13] = Math.round(spec.transform[13] * 100000) / 100000;
            }
            result.modified = true;
          }
          specs.push(spec);
          node = node._next;
        }
      }
      this._contextState.addCount = 0;
      this._contextState.removeCount = 0;
      return result;
    };
    LayoutNodeManager.prototype.getNodeByRenderNode = function(renderable) {
      var node = this._first;
      while (node) {
        if (node.renderNode === renderable) {
          return node;
        }
        node = node._next;
      }
      return undefined;
    };
    LayoutNodeManager.prototype.insertNode = function(node) {
      node._next = this._first;
      if (this._first) {
        this._first._prev = node;
      }
      this._first = node;
    };
    LayoutNodeManager.prototype.setNodeOptions = function(options) {
      this._nodeOptions = options;
      var node = this._first;
      while (node) {
        node.setOptions(options);
        node = node._next;
      }
      node = this._pool.layoutNodes.first;
      while (node) {
        node.setOptions(options);
        node = node._next;
      }
    };
    LayoutNodeManager.prototype.preallocateNodes = function(count, spec) {
      var nodes = [];
      for (var i = 0; i < count; i++) {
        nodes.push(this.createNode(undefined, spec));
      }
      for (i = 0; i < count; i++) {
        _destroyNode.call(this, nodes[i]);
      }
    };
    LayoutNodeManager.prototype.createNode = function(renderNode, spec) {
      var node;
      if (this._pool.layoutNodes.first) {
        node = this._pool.layoutNodes.first;
        this._pool.layoutNodes.first = node._next;
        this._pool.layoutNodes.size--;
        node.constructor.apply(node, arguments);
      } else {
        node = new this.LayoutNode(renderNode, spec);
        if (this._nodeOptions) {
          node.setOptions(this._nodeOptions);
        }
      }
      node._prev = undefined;
      node._next = undefined;
      node._viewSequence = undefined;
      node._layoutCount = 0;
      if (this._initLayoutNodeFn) {
        this._initLayoutNodeFn.call(this, node, spec);
      }
      return node;
    };
    function _destroyNode(node) {
      if (node._next) {
        node._next._prev = node._prev;
      }
      if (node._prev) {
        node._prev._next = node._next;
      } else {
        this._first = node._next;
      }
      node.destroy();
      if (this._pool.layoutNodes.size < MAX_POOL_SIZE) {
        this._pool.layoutNodes.size++;
        node._prev = undefined;
        node._next = this._pool.layoutNodes.first;
        this._pool.layoutNodes.first = node;
      }
    }
    LayoutNodeManager.prototype.getStartEnumNode = function(next) {
      if (next === undefined) {
        return this._first;
      } else if (next === true) {
        return (this._contextState.start && this._contextState.startPrev) ? this._contextState.start._next : this._contextState.start;
      } else if (next === false) {
        return (this._contextState.start && !this._contextState.startPrev) ? this._contextState.start._prev : this._contextState.start;
      }
    };
    function _contextGetCreateAndOrderNodes(renderNode, prev) {
      var node;
      var state = this._contextState;
      if (!state.start) {
        node = this._first;
        while (node) {
          if (node.renderNode === renderNode) {
            break;
          }
          node = node._next;
        }
        if (!node) {
          node = this.createNode(renderNode);
          node._next = this._first;
          if (this._first) {
            this._first._prev = node;
          }
          this._first = node;
        }
        state.start = node;
        state.startPrev = prev;
        state.prev = node;
        state.next = node;
        return node;
      }
      if (prev) {
        if (state.prev._prev && (state.prev._prev.renderNode === renderNode)) {
          state.prev = state.prev._prev;
          return state.prev;
        }
      } else {
        if (state.next._next && (state.next._next.renderNode === renderNode)) {
          state.next = state.next._next;
          return state.next;
        }
      }
      node = this._first;
      while (node) {
        if (node.renderNode === renderNode) {
          break;
        }
        node = node._next;
      }
      if (!node) {
        node = this.createNode(renderNode);
      } else {
        if (node._next) {
          node._next._prev = node._prev;
        }
        if (node._prev) {
          node._prev._next = node._next;
        } else {
          this._first = node._next;
        }
        node._next = undefined;
        node._prev = undefined;
      }
      if (prev) {
        if (state.prev._prev) {
          node._prev = state.prev._prev;
          state.prev._prev._next = node;
        } else {
          this._first = node;
        }
        state.prev._prev = node;
        node._next = state.prev;
        state.prev = node;
      } else {
        if (state.next._next) {
          node._next = state.next._next;
          state.next._next._prev = node;
        }
        state.next._next = node;
        node._prev = state.next;
        state.next = node;
      }
      return node;
    }
    function _contextNext() {
      if (!this._contextState.nextSequence) {
        return undefined;
      }
      if (this._context.reverse) {
        this._contextState.nextSequence = this._contextState.nextSequence.getNext();
        if (!this._contextState.nextSequence) {
          return undefined;
        }
      }
      var renderNode = this._contextState.nextSequence.get();
      if (!renderNode) {
        this._contextState.nextSequence = undefined;
        return undefined;
      }
      var nextSequence = this._contextState.nextSequence;
      if (!this._context.reverse) {
        this._contextState.nextSequence = this._contextState.nextSequence.getNext();
      }
      return {
        renderNode: renderNode,
        viewSequence: nextSequence,
        next: true,
        index: ++this._contextState.nextGetIndex
      };
    }
    function _contextPrev() {
      if (!this._contextState.prevSequence) {
        return undefined;
      }
      if (!this._context.reverse) {
        this._contextState.prevSequence = this._contextState.prevSequence.getPrevious();
        if (!this._contextState.prevSequence) {
          return undefined;
        }
      }
      var renderNode = this._contextState.prevSequence.get();
      if (!renderNode) {
        this._contextState.prevSequence = undefined;
        return undefined;
      }
      var prevSequence = this._contextState.prevSequence;
      if (this._context.reverse) {
        this._contextState.prevSequence = this._contextState.prevSequence.getPrevious();
      }
      return {
        renderNode: renderNode,
        viewSequence: prevSequence,
        prev: true,
        index: --this._contextState.prevGetIndex
      };
    }
    function _contextGet(contextNodeOrId) {
      if (this._nodesById && ((contextNodeOrId instanceof String) || (typeof contextNodeOrId === 'string'))) {
        var renderNode = this._nodesById[contextNodeOrId];
        if (!renderNode) {
          return undefined;
        }
        if (renderNode instanceof Array) {
          var result = [];
          for (var i = 0,
              j = renderNode.length; i < j; i++) {
            result.push({
              renderNode: renderNode[i],
              arrayElement: true
            });
          }
          return result;
        }
        return {
          renderNode: renderNode,
          byId: true
        };
      } else {
        return contextNodeOrId;
      }
    }
    function _contextSet(contextNodeOrId, set) {
      var contextNode = this._nodesById ? _contextGet.call(this, contextNodeOrId) : contextNodeOrId;
      if (contextNode) {
        var node = contextNode.node;
        if (!node) {
          if (contextNode.next) {
            if (contextNode.index < this._contextState.nextSetIndex) {
              LayoutUtility.error('Nodes must be layed out in the same order as they were requested!');
            }
            this._contextState.nextSetIndex = contextNode.index;
          } else if (contextNode.prev) {
            if (contextNode.index > this._contextState.prevSetIndex) {
              LayoutUtility.error('Nodes must be layed out in the same order as they were requested!');
            }
            this._contextState.prevSetIndex = contextNode.index;
          }
          node = _contextGetCreateAndOrderNodes.call(this, contextNode.renderNode, contextNode.prev);
          node._viewSequence = contextNode.viewSequence;
          node._layoutCount++;
          if (node._layoutCount === 1) {
            this._contextState.addCount++;
          }
          contextNode.node = node;
        }
        node.usesTrueSize = contextNode.usesTrueSize;
        node.trueSizeRequested = contextNode.trueSizeRequested;
        node.set(set, this._context.size);
        contextNode.set = set;
      }
      return set;
    }
    function _contextResolveSize(contextNodeOrId, parentSize) {
      var contextNode = this._nodesById ? _contextGet.call(this, contextNodeOrId) : contextNodeOrId;
      var resolveSize = this._pool.resolveSize;
      if (!contextNode) {
        resolveSize[0] = 0;
        resolveSize[1] = 0;
        return resolveSize;
      }
      var renderNode = contextNode.renderNode;
      var size = renderNode.getSize();
      if (!size) {
        return parentSize;
      }
      var configSize = renderNode.size && (renderNode._trueSizeCheck !== undefined) ? renderNode.size : undefined;
      if (configSize && ((configSize[0] === true) || (configSize[1] === true))) {
        contextNode.usesTrueSize = true;
        var backupSize = renderNode._backupSize;
        if (renderNode._trueSizeCheck) {
          if (backupSize && (configSize !== size)) {
            var newWidth = (configSize[0] === true) ? Math.max(backupSize[0], size[0]) : size[0];
            var newHeight = (configSize[1] === true) ? Math.max(backupSize[1], size[1]) : size[1];
            if ((newWidth !== backupSize[0]) || (newHeight !== backupSize[1])) {
              this._trueSizeRequested = true;
              contextNode.trueSizeRequested = true;
            }
            backupSize[0] = newWidth;
            backupSize[1] = newHeight;
            size = backupSize;
            renderNode._backupSize = undefined;
            backupSize = undefined;
          } else {
            this._trueSizeRequested = true;
            contextNode.trueSizeRequested = true;
          }
        }
        if (this._reevalTrueSize || (backupSize && ((backupSize[0] !== size[0]) || (backupSize[1] !== size[1])))) {
          renderNode._trueSizeCheck = true;
          renderNode._sizeDirty = true;
          this._trueSizeRequested = true;
        }
        if (!backupSize) {
          renderNode._backupSize = [0, 0];
          backupSize = renderNode._backupSize;
        }
        backupSize[0] = size[0];
        backupSize[1] = size[1];
      }
      configSize = renderNode._nodes ? renderNode.options.size : undefined;
      if (configSize && ((configSize[0] === true) || (configSize[1] === true))) {
        if (this._reevalTrueSize || renderNode._nodes._trueSizeRequested) {
          contextNode.usesTrueSize = true;
          contextNode.trueSizeRequested = true;
          this._trueSizeRequested = true;
        }
      }
      if ((size[0] === undefined) || (size[0] === true) || (size[1] === undefined) || (size[1] === true)) {
        resolveSize[0] = size[0];
        resolveSize[1] = size[1];
        size = resolveSize;
        if (size[0] === undefined) {
          size[0] = parentSize[0];
        } else if (size[0] === true) {
          size[0] = 0;
          this._trueSizeRequested = true;
          contextNode.trueSizeRequested = true;
        }
        if (size[1] === undefined) {
          size[1] = parentSize[1];
        } else if (size[1] === true) {
          size[1] = 0;
          this._trueSizeRequested = true;
          contextNode.trueSizeRequested = true;
        }
      }
      return size;
    }
    module.exports = LayoutNodeManager;
  }).call(__exports, __require, __exports, __module);
});


})();
(function() {
function define(){};  define.amd = {};
System.register("github:IjzerenHein/famous-flex@0.2.0/src/FlexScrollView", ["github:IjzerenHein/famous-flex@0.2.0/src/LayoutUtility", "github:IjzerenHein/famous-flex@0.2.0/src/ScrollController", "github:IjzerenHein/famous-flex@0.2.0/src/layouts/ListLayout"], false, function(__require, __exports, __module) {
  return (function(require, exports, module) {
    var LayoutUtility = require("github:IjzerenHein/famous-flex@0.2.0/src/LayoutUtility");
    var ScrollController = require("github:IjzerenHein/famous-flex@0.2.0/src/ScrollController");
    var ListLayout = require("github:IjzerenHein/famous-flex@0.2.0/src/layouts/ListLayout");
    var PullToRefreshState = {
      HIDDEN: 0,
      PULLING: 1,
      ACTIVE: 2,
      COMPLETED: 3,
      HIDDING: 4
    };
    function FlexScrollView(options) {
      ScrollController.call(this, LayoutUtility.combineOptions(FlexScrollView.DEFAULT_OPTIONS, options));
      this._thisScrollViewDelta = 0;
      this._leadingScrollViewDelta = 0;
      this._trailingScrollViewDelta = 0;
    }
    FlexScrollView.prototype = Object.create(ScrollController.prototype);
    FlexScrollView.prototype.constructor = FlexScrollView;
    FlexScrollView.PullToRefreshState = PullToRefreshState;
    FlexScrollView.DEFAULT_OPTIONS = {
      layout: ListLayout,
      direction: undefined,
      paginated: false,
      alignment: 0,
      flow: false,
      mouseMove: false,
      useContainer: false,
      visibleItemThresshold: 0.5,
      pullToRefreshHeader: undefined,
      pullToRefreshFooter: undefined,
      leadingScrollView: undefined,
      trailingScrollView: undefined
    };
    FlexScrollView.prototype.setOptions = function(options) {
      ScrollController.prototype.setOptions.call(this, options);
      if (options.pullToRefreshHeader || options.pullToRefreshFooter || this._pullToRefresh) {
        if (options.pullToRefreshHeader) {
          this._pullToRefresh = this._pullToRefresh || [undefined, undefined];
          if (!this._pullToRefresh[0]) {
            this._pullToRefresh[0] = {
              state: PullToRefreshState.HIDDEN,
              prevState: PullToRefreshState.HIDDEN,
              footer: false
            };
          }
          this._pullToRefresh[0].node = options.pullToRefreshHeader;
        } else if (!this.options.pullToRefreshHeader && this._pullToRefresh) {
          this._pullToRefresh[0] = undefined;
        }
        if (options.pullToRefreshFooter) {
          this._pullToRefresh = this._pullToRefresh || [undefined, undefined];
          if (!this._pullToRefresh[1]) {
            this._pullToRefresh[1] = {
              state: PullToRefreshState.HIDDEN,
              prevState: PullToRefreshState.HIDDEN,
              footer: true
            };
          }
          this._pullToRefresh[1].node = options.pullToRefreshFooter;
        } else if (!this.options.pullToRefreshFooter && this._pullToRefresh) {
          this._pullToRefresh[1] = undefined;
        }
        if (this._pullToRefresh && !this._pullToRefresh[0] && !this._pullToRefresh[1]) {
          this._pullToRefresh = undefined;
        }
      }
      return this;
    };
    FlexScrollView.prototype.sequenceFrom = function(node) {
      return this.setDataSource(node);
    };
    FlexScrollView.prototype.getCurrentIndex = function getCurrentIndex() {
      var item = this.getFirstVisibleItem();
      return item ? item.viewSequence.getIndex() : -1;
    };
    FlexScrollView.prototype.goToPage = function goToPage(index) {
      var viewSequence = this._viewSequence;
      if (!viewSequence) {
        return this;
      }
      while (viewSequence.getIndex() < index) {
        viewSequence = viewSequence.getNext();
        if (!viewSequence) {
          return this;
        }
      }
      while (viewSequence.getIndex() > index) {
        viewSequence = viewSequence.getPrevious();
        if (!viewSequence) {
          return this;
        }
      }
      this.goToRenderNode(viewSequence.get());
      return this;
    };
    FlexScrollView.prototype.getOffset = function() {
      return this._scrollOffsetCache;
    };
    FlexScrollView.prototype.getPosition = FlexScrollView.prototype.getOffset;
    function _setPullToRefreshState(pullToRefresh, state) {
      if (pullToRefresh.state !== state) {
        pullToRefresh.state = state;
        if (pullToRefresh.node && pullToRefresh.node.setPullToRefreshStatus) {
          pullToRefresh.node.setPullToRefreshStatus(state);
        }
      }
    }
    function _getPullToRefresh(footer) {
      return this._pullToRefresh ? this._pullToRefresh[footer ? 1 : 0] : undefined;
    }
    FlexScrollView.prototype._postLayout = function(size, scrollOffset) {
      if (!this._pullToRefresh) {
        return ;
      }
      if (this.options.alignment) {
        scrollOffset += size[this._direction];
      }
      var prevHeight;
      var nextHeight;
      var totalHeight;
      for (var i = 0; i < 2; i++) {
        var pullToRefresh = this._pullToRefresh[i];
        if (pullToRefresh) {
          var length = pullToRefresh.node.getSize()[this._direction];
          var pullLength = pullToRefresh.node.getPullToRefreshSize ? pullToRefresh.node.getPullToRefreshSize()[this._direction] : length;
          var offset;
          if (!pullToRefresh.footer) {
            prevHeight = this._calcScrollHeight(false);
            prevHeight = (prevHeight === undefined) ? -1 : prevHeight;
            offset = (prevHeight >= 0) ? (scrollOffset - prevHeight) : prevHeight;
            if (this.options.alignment) {
              nextHeight = this._calcScrollHeight(true);
              nextHeight = (nextHeight === undefined) ? -1 : nextHeight;
              totalHeight = ((prevHeight >= 0) && (nextHeight >= 0)) ? (prevHeight + nextHeight) : -1;
              if ((totalHeight >= 0) && (totalHeight < size[this._direction])) {
                offset = Math.round((scrollOffset - size[this._direction]) + nextHeight);
              }
            }
          } else {
            nextHeight = (nextHeight === undefined) ? nextHeight = this._calcScrollHeight(true) : nextHeight;
            nextHeight = (nextHeight === undefined) ? -1 : nextHeight;
            offset = (nextHeight >= 0) ? (scrollOffset + nextHeight) : (size[this._direction] + 1);
            if (!this.options.alignment) {
              prevHeight = (prevHeight === undefined) ? this._calcScrollHeight(false) : prevHeight;
              prevHeight = (prevHeight === undefined) ? -1 : prevHeight;
              totalHeight = ((prevHeight >= 0) && (nextHeight >= 0)) ? (prevHeight + nextHeight) : -1;
              if ((totalHeight >= 0) && (totalHeight < size[this._direction])) {
                offset = Math.round((scrollOffset - prevHeight) + size[this._direction]);
              }
            }
            offset = -(offset - size[this._direction]);
          }
          var visiblePerc = Math.max(Math.min(offset / pullLength, 1), 0);
          switch (pullToRefresh.state) {
            case PullToRefreshState.HIDDEN:
              if (this._scroll.scrollForceCount) {
                if (visiblePerc >= 1) {
                  _setPullToRefreshState(pullToRefresh, PullToRefreshState.ACTIVE);
                } else if (offset >= 0.2) {
                  _setPullToRefreshState(pullToRefresh, PullToRefreshState.PULLING);
                }
              }
              break;
            case PullToRefreshState.PULLING:
              if (this._scroll.scrollForceCount && (visiblePerc >= 1)) {
                _setPullToRefreshState(pullToRefresh, PullToRefreshState.ACTIVE);
              } else if (offset < 0.2) {
                _setPullToRefreshState(pullToRefresh, PullToRefreshState.HIDDEN);
              }
              break;
            case PullToRefreshState.ACTIVE:
              break;
            case PullToRefreshState.COMPLETED:
              if (!this._scroll.scrollForceCount) {
                if (offset >= 0.2) {
                  _setPullToRefreshState(pullToRefresh, PullToRefreshState.HIDDING);
                } else {
                  _setPullToRefreshState(pullToRefresh, PullToRefreshState.HIDDEN);
                }
              }
              break;
            case PullToRefreshState.HIDDING:
              if (offset < 0.2) {
                _setPullToRefreshState(pullToRefresh, PullToRefreshState.HIDDEN);
              }
              break;
          }
          if (pullToRefresh.state !== PullToRefreshState.HIDDEN) {
            var contextNode = {
              renderNode: pullToRefresh.node,
              prev: !pullToRefresh.footer,
              next: pullToRefresh.footer,
              index: !pullToRefresh.footer ? --this._nodes._contextState.prevGetIndex : ++this._nodes._contextState.nextGetIndex
            };
            var scrollLength;
            if (pullToRefresh.state === PullToRefreshState.ACTIVE) {
              scrollLength = length;
            } else if (this._scroll.scrollForceCount) {
              scrollLength = Math.min(offset, length);
            }
            var set = {
              size: [size[0], size[1]],
              translate: [0, 0, -1e-3],
              scrollLength: scrollLength
            };
            set.size[this._direction] = Math.max(Math.min(offset, pullLength), 0);
            set.translate[this._direction] = pullToRefresh.footer ? (size[this._direction] - length) : 0;
            this._nodes._context.set(contextNode, set);
          }
        }
      }
    };
    FlexScrollView.prototype.showPullToRefresh = function(footer) {
      var pullToRefresh = _getPullToRefresh.call(this, footer);
      if (pullToRefresh) {
        _setPullToRefreshState(pullToRefresh, PullToRefreshState.ACTIVE);
        this._scroll.scrollDirty = true;
      }
    };
    FlexScrollView.prototype.hidePullToRefresh = function(footer) {
      var pullToRefresh = _getPullToRefresh.call(this, footer);
      if (pullToRefresh && (pullToRefresh.state === PullToRefreshState.ACTIVE)) {
        _setPullToRefreshState(pullToRefresh, PullToRefreshState.COMPLETED);
        this._scroll.scrollDirty = true;
      }
      return this;
    };
    FlexScrollView.prototype.isPullToRefreshVisible = function(footer) {
      var pullToRefresh = _getPullToRefresh.call(this, footer);
      return pullToRefresh ? (pullToRefresh.state === PullToRefreshState.ACTIVE) : false;
    };
    FlexScrollView.prototype.applyScrollForce = function(delta) {
      var leadingScrollView = this.options.leadingScrollView;
      var trailingScrollView = this.options.trailingScrollView;
      if (!leadingScrollView && !trailingScrollView) {
        return ScrollController.prototype.applyScrollForce.call(this, delta);
      }
      var partialDelta;
      if (delta < 0) {
        if (leadingScrollView) {
          partialDelta = leadingScrollView.canScroll(delta);
          this._leadingScrollViewDelta += partialDelta;
          leadingScrollView.applyScrollForce(partialDelta);
          delta -= partialDelta;
        }
        if (trailingScrollView) {
          partialDelta = this.canScroll(delta);
          ScrollController.prototype.applyScrollForce.call(this, partialDelta);
          this._thisScrollViewDelta += partialDelta;
          delta -= partialDelta;
          trailingScrollView.applyScrollForce(delta);
          this._trailingScrollViewDelta += delta;
        } else {
          ScrollController.prototype.applyScrollForce.call(this, delta);
          this._thisScrollViewDelta += delta;
        }
      } else {
        if (trailingScrollView) {
          partialDelta = trailingScrollView.canScroll(delta);
          trailingScrollView.applyScrollForce(partialDelta);
          this._trailingScrollViewDelta += partialDelta;
          delta -= partialDelta;
        }
        if (leadingScrollView) {
          partialDelta = this.canScroll(delta);
          ScrollController.prototype.applyScrollForce.call(this, partialDelta);
          this._thisScrollViewDelta += partialDelta;
          delta -= partialDelta;
          leadingScrollView.applyScrollForce(delta);
          this._leadingScrollViewDelta += delta;
        } else {
          ScrollController.prototype.applyScrollForce.call(this, delta);
          this._thisScrollViewDelta += delta;
        }
      }
      return this;
    };
    FlexScrollView.prototype.updateScrollForce = function(prevDelta, newDelta) {
      var leadingScrollView = this.options.leadingScrollView;
      var trailingScrollView = this.options.trailingScrollView;
      if (!leadingScrollView && !trailingScrollView) {
        return ScrollController.prototype.updateScrollForce.call(this, prevDelta, newDelta);
      }
      var partialDelta;
      var delta = newDelta - prevDelta;
      if (delta < 0) {
        if (leadingScrollView) {
          partialDelta = leadingScrollView.canScroll(delta);
          leadingScrollView.updateScrollForce(this._leadingScrollViewDelta, this._leadingScrollViewDelta + partialDelta);
          this._leadingScrollViewDelta += partialDelta;
          delta -= partialDelta;
        }
        if (trailingScrollView && delta) {
          partialDelta = this.canScroll(delta);
          ScrollController.prototype.updateScrollForce.call(this, this._thisScrollViewDelta, this._thisScrollViewDelta + partialDelta);
          this._thisScrollViewDelta += partialDelta;
          delta -= partialDelta;
          this._trailingScrollViewDelta += delta;
          trailingScrollView.updateScrollForce(this._trailingScrollViewDelta, this._trailingScrollViewDelta + delta);
        } else if (delta) {
          ScrollController.prototype.updateScrollForce.call(this, this._thisScrollViewDelta, this._thisScrollViewDelta + delta);
          this._thisScrollViewDelta += delta;
        }
      } else {
        if (trailingScrollView) {
          partialDelta = trailingScrollView.canScroll(delta);
          trailingScrollView.updateScrollForce(this._trailingScrollViewDelta, this._trailingScrollViewDelta + partialDelta);
          this._trailingScrollViewDelta += partialDelta;
          delta -= partialDelta;
        }
        if (leadingScrollView) {
          partialDelta = this.canScroll(delta);
          ScrollController.prototype.updateScrollForce.call(this, this._thisScrollViewDelta, this._thisScrollViewDelta + partialDelta);
          this._thisScrollViewDelta += partialDelta;
          delta -= partialDelta;
          leadingScrollView.updateScrollForce(this._leadingScrollViewDelta, this._leadingScrollViewDelta + delta);
          this._leadingScrollViewDelta += delta;
        } else {
          ScrollController.prototype.updateScrollForce.call(this, this._thisScrollViewDelta, this._thisScrollViewDelta + delta);
          this._thisScrollViewDelta += delta;
        }
      }
      return this;
    };
    FlexScrollView.prototype.releaseScrollForce = function(delta, velocity) {
      var leadingScrollView = this.options.leadingScrollView;
      var trailingScrollView = this.options.trailingScrollView;
      if (!leadingScrollView && !trailingScrollView) {
        return ScrollController.prototype.releaseScrollForce.call(this, delta, velocity);
      }
      var partialDelta;
      if (delta < 0) {
        if (leadingScrollView) {
          partialDelta = Math.max(this._leadingScrollViewDelta, delta);
          this._leadingScrollViewDelta -= partialDelta;
          delta -= partialDelta;
          leadingScrollView.releaseScrollForce(this._leadingScrollViewDelta, delta ? 0 : velocity);
        }
        if (trailingScrollView) {
          partialDelta = Math.max(this._thisScrollViewDelta, delta);
          this._thisScrollViewDelta -= partialDelta;
          delta -= partialDelta;
          ScrollController.prototype.releaseScrollForce.call(this, this._thisScrollViewDelta, delta ? 0 : velocity);
          this._trailingScrollViewDelta -= delta;
          trailingScrollView.releaseScrollForce(this._trailingScrollViewDelta, delta ? velocity : 0);
        } else {
          this._thisScrollViewDelta -= delta;
          ScrollController.prototype.releaseScrollForce.call(this, this._thisScrollViewDelta, delta ? velocity : 0);
        }
      } else {
        if (trailingScrollView) {
          partialDelta = Math.min(this._trailingScrollViewDelta, delta);
          this._trailingScrollViewDelta -= partialDelta;
          delta -= partialDelta;
          trailingScrollView.releaseScrollForce(this._trailingScrollViewDelta, delta ? 0 : velocity);
        }
        if (leadingScrollView) {
          partialDelta = Math.min(this._thisScrollViewDelta, delta);
          this._thisScrollViewDelta -= partialDelta;
          delta -= partialDelta;
          ScrollController.prototype.releaseScrollForce.call(this, this._thisScrollViewDelta, delta ? 0 : velocity);
          this._leadingScrollViewDelta -= delta;
          leadingScrollView.releaseScrollForce(this._leadingScrollViewDelta, delta ? velocity : 0);
        } else {
          this._thisScrollViewDelta -= delta;
          ScrollController.prototype.updateScrollForce.call(this, this._thisScrollViewDelta, delta ? velocity : 0);
        }
      }
      return this;
    };
    FlexScrollView.prototype.commit = function(context) {
      var result = ScrollController.prototype.commit.call(this, context);
      if (this._pullToRefresh) {
        for (var i = 0; i < 2; i++) {
          var pullToRefresh = this._pullToRefresh[i];
          if (pullToRefresh) {
            if ((pullToRefresh.state === PullToRefreshState.ACTIVE) && (pullToRefresh.prevState !== PullToRefreshState.ACTIVE)) {
              this._eventOutput.emit('refresh', {
                target: this,
                footer: pullToRefresh.footer
              });
            }
            pullToRefresh.prevState = pullToRefresh.state;
          }
        }
      }
      return result;
    };
    module.exports = FlexScrollView;
  }).call(__exports, __require, __exports, __module);
});


})();
System.register("npm:famous@0.3.5/core/RenderNode", ["npm:famous@0.3.5/core/Entity", "npm:famous@0.3.5/core/SpecParser"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var Entity = require("npm:famous@0.3.5/core/Entity");
  var SpecParser = require("npm:famous@0.3.5/core/SpecParser");
  function RenderNode(object) {
    this._object = null;
    this._child = null;
    this._hasMultipleChildren = false;
    this._isRenderable = false;
    this._isModifier = false;
    this._resultCache = {};
    this._prevResults = {};
    this._childResult = null;
    if (object)
      this.set(object);
  }
  RenderNode.prototype.add = function add(child) {
    var childNode = child instanceof RenderNode ? child : new RenderNode(child);
    if (this._child instanceof Array)
      this._child.push(childNode);
    else if (this._child) {
      this._child = [this._child, childNode];
      this._hasMultipleChildren = true;
      this._childResult = [];
    } else
      this._child = childNode;
    return childNode;
  };
  RenderNode.prototype.get = function get() {
    return this._object || (this._hasMultipleChildren ? null : this._child ? this._child.get() : null);
  };
  RenderNode.prototype.set = function set(child) {
    this._childResult = null;
    this._hasMultipleChildren = false;
    this._isRenderable = child.render ? true : false;
    this._isModifier = child.modify ? true : false;
    this._object = child;
    this._child = null;
    if (child instanceof RenderNode)
      return child;
    else
      return this;
  };
  RenderNode.prototype.getSize = function getSize() {
    var result = null;
    var target = this.get();
    if (target && target.getSize)
      result = target.getSize();
    if (!result && this._child && this._child.getSize)
      result = this._child.getSize();
    return result;
  };
  function _applyCommit(spec, context, cacheStorage) {
    var result = SpecParser.parse(spec, context);
    var keys = Object.keys(result);
    for (var i = 0; i < keys.length; i++) {
      var id = keys[i];
      var childNode = Entity.get(id);
      var commitParams = result[id];
      commitParams.allocator = context.allocator;
      var commitResult = childNode.commit(commitParams);
      if (commitResult)
        _applyCommit(commitResult, context, cacheStorage);
      else
        cacheStorage[id] = commitParams;
    }
  }
  RenderNode.prototype.commit = function commit(context) {
    var prevKeys = Object.keys(this._prevResults);
    for (var i = 0; i < prevKeys.length; i++) {
      var id = prevKeys[i];
      if (this._resultCache[id] === undefined) {
        var object = Entity.get(id);
        if (object.cleanup)
          object.cleanup(context.allocator);
      }
    }
    this._prevResults = this._resultCache;
    this._resultCache = {};
    _applyCommit(this.render(), context, this._resultCache);
  };
  RenderNode.prototype.render = function render() {
    if (this._isRenderable)
      return this._object.render();
    var result = null;
    if (this._hasMultipleChildren) {
      result = this._childResult;
      var children = this._child;
      for (var i = 0; i < children.length; i++) {
        result[i] = children[i].render();
      }
    } else if (this._child)
      result = this._child.render();
    return this._isModifier ? this._object.modify(result) : result;
  };
  module.exports = RenderNode;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/transitions/Transitionable", ["npm:famous@0.3.5/transitions/MultipleTransition", "npm:famous@0.3.5/transitions/TweenTransition"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var MultipleTransition = require("npm:famous@0.3.5/transitions/MultipleTransition");
  var TweenTransition = require("npm:famous@0.3.5/transitions/TweenTransition");
  function Transitionable(start) {
    this.currentAction = null;
    this.actionQueue = [];
    this.callbackQueue = [];
    this.state = 0;
    this.velocity = undefined;
    this._callback = undefined;
    this._engineInstance = null;
    this._currentMethod = null;
    this.set(start);
  }
  var transitionMethods = {};
  Transitionable.register = function register(methods) {
    var success = true;
    for (var method in methods) {
      if (!Transitionable.registerMethod(method, methods[method]))
        success = false;
    }
    return success;
  };
  Transitionable.registerMethod = function registerMethod(name, engineClass) {
    if (!(name in transitionMethods)) {
      transitionMethods[name] = engineClass;
      return true;
    } else
      return false;
  };
  Transitionable.unregisterMethod = function unregisterMethod(name) {
    if (name in transitionMethods) {
      delete transitionMethods[name];
      return true;
    } else
      return false;
  };
  function _loadNext() {
    if (this._callback) {
      var callback = this._callback;
      this._callback = undefined;
      callback();
    }
    if (this.actionQueue.length <= 0) {
      this.set(this.get());
      return ;
    }
    this.currentAction = this.actionQueue.shift();
    this._callback = this.callbackQueue.shift();
    var method = null;
    var endValue = this.currentAction[0];
    var transition = this.currentAction[1];
    if (transition instanceof Object && transition.method) {
      method = transition.method;
      if (typeof method === 'string')
        method = transitionMethods[method];
    } else {
      method = TweenTransition;
    }
    if (this._currentMethod !== method) {
      if (!(endValue instanceof Object) || method.SUPPORTS_MULTIPLE === true || endValue.length <= method.SUPPORTS_MULTIPLE) {
        this._engineInstance = new method();
      } else {
        this._engineInstance = new MultipleTransition(method);
      }
      this._currentMethod = method;
    }
    this._engineInstance.reset(this.state, this.velocity);
    if (this.velocity !== undefined)
      transition.velocity = this.velocity;
    this._engineInstance.set(endValue, transition, _loadNext.bind(this));
  }
  Transitionable.prototype.set = function set(endState, transition, callback) {
    if (!transition) {
      this.reset(endState);
      if (callback)
        callback();
      return this;
    }
    var action = [endState, transition];
    this.actionQueue.push(action);
    this.callbackQueue.push(callback);
    if (!this.currentAction)
      _loadNext.call(this);
    return this;
  };
  Transitionable.prototype.reset = function reset(startState, startVelocity) {
    this._currentMethod = null;
    this._engineInstance = null;
    this._callback = undefined;
    this.state = startState;
    this.velocity = startVelocity;
    this.currentAction = null;
    this.actionQueue = [];
    this.callbackQueue = [];
  };
  Transitionable.prototype.delay = function delay(duration, callback) {
    var endValue;
    if (this.actionQueue.length)
      endValue = this.actionQueue[this.actionQueue.length - 1][0];
    else if (this.currentAction)
      endValue = this.currentAction[0];
    else
      endValue = this.get();
    return this.set(endValue, {
      duration: duration,
      curve: function() {
        return 0;
      }
    }, callback);
  };
  Transitionable.prototype.get = function get(timestamp) {
    if (this._engineInstance) {
      if (this._engineInstance.getVelocity)
        this.velocity = this._engineInstance.getVelocity();
      this.state = this._engineInstance.get(timestamp);
    }
    return this.state;
  };
  Transitionable.prototype.isActive = function isActive() {
    return !!this.currentAction;
  };
  Transitionable.prototype.halt = function halt() {
    return this.set(this.get());
  };
  module.exports = Transitionable;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/inputs/index", ["npm:famous@0.3.5/inputs/Accumulator", "npm:famous@0.3.5/inputs/DesktopEmulationMode", "npm:famous@0.3.5/inputs/FastClick", "npm:famous@0.3.5/inputs/GenericSync", "npm:famous@0.3.5/inputs/MouseSync", "npm:famous@0.3.5/inputs/PinchSync", "npm:famous@0.3.5/inputs/RotateSync", "npm:famous@0.3.5/inputs/ScaleSync", "npm:famous@0.3.5/inputs/ScrollSync", "npm:famous@0.3.5/inputs/TouchSync", "npm:famous@0.3.5/inputs/TouchTracker", "npm:famous@0.3.5/inputs/TwoFingerSync"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    Accumulator: require("npm:famous@0.3.5/inputs/Accumulator"),
    DesktopEmulationMode: require("npm:famous@0.3.5/inputs/DesktopEmulationMode"),
    FastClick: require("npm:famous@0.3.5/inputs/FastClick"),
    GenericSync: require("npm:famous@0.3.5/inputs/GenericSync"),
    MouseSync: require("npm:famous@0.3.5/inputs/MouseSync"),
    PinchSync: require("npm:famous@0.3.5/inputs/PinchSync"),
    RotateSync: require("npm:famous@0.3.5/inputs/RotateSync"),
    ScaleSync: require("npm:famous@0.3.5/inputs/ScaleSync"),
    ScrollSync: require("npm:famous@0.3.5/inputs/ScrollSync"),
    TouchSync: require("npm:famous@0.3.5/inputs/TouchSync"),
    TouchTracker: require("npm:famous@0.3.5/inputs/TouchTracker"),
    TwoFingerSync: require("npm:famous@0.3.5/inputs/TwoFingerSync")
  };
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/math/index", ["npm:famous@0.3.5/math/Matrix", "npm:famous@0.3.5/math/Quaternion", "npm:famous@0.3.5/math/Random", "npm:famous@0.3.5/math/Utilities", "npm:famous@0.3.5/math/Vector"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    Matrix: require("npm:famous@0.3.5/math/Matrix"),
    Quaternion: require("npm:famous@0.3.5/math/Quaternion"),
    Random: require("npm:famous@0.3.5/math/Random"),
    Utilities: require("npm:famous@0.3.5/math/Utilities"),
    Vector: require("npm:famous@0.3.5/math/Vector")
  };
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/physics/bodies/Body", ["npm:famous@0.3.5/physics/bodies/Particle", "npm:famous@0.3.5/core/Transform", "npm:famous@0.3.5/math/Vector", "npm:famous@0.3.5/math/Quaternion", "npm:famous@0.3.5/math/Matrix", "npm:famous@0.3.5/physics/integrators/SymplecticEuler"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var Particle = require("npm:famous@0.3.5/physics/bodies/Particle");
  var Transform = require("npm:famous@0.3.5/core/Transform");
  var Vector = require("npm:famous@0.3.5/math/Vector");
  var Quaternion = require("npm:famous@0.3.5/math/Quaternion");
  var Matrix = require("npm:famous@0.3.5/math/Matrix");
  var Integrator = require("npm:famous@0.3.5/physics/integrators/SymplecticEuler");
  function Body(options) {
    Particle.call(this, options);
    options = options || {};
    this.orientation = new Quaternion();
    this.angularVelocity = new Vector();
    this.angularMomentum = new Vector();
    this.torque = new Vector();
    if (options.orientation)
      this.orientation.set(options.orientation);
    if (options.angularVelocity)
      this.angularVelocity.set(options.angularVelocity);
    if (options.angularMomentum)
      this.angularMomentum.set(options.angularMomentum);
    if (options.torque)
      this.torque.set(options.torque);
    this.angularVelocity.w = 0;
    this.setMomentsOfInertia();
    this.pWorld = new Vector();
  }
  Body.DEFAULT_OPTIONS = Particle.DEFAULT_OPTIONS;
  Body.DEFAULT_OPTIONS.orientation = [0, 0, 0, 1];
  Body.DEFAULT_OPTIONS.angularVelocity = [0, 0, 0];
  Body.prototype = Object.create(Particle.prototype);
  Body.prototype.constructor = Body;
  Body.prototype.isBody = true;
  Body.prototype.setMass = function setMass() {
    Particle.prototype.setMass.apply(this, arguments);
    this.setMomentsOfInertia();
  };
  Body.prototype.setMomentsOfInertia = function setMomentsOfInertia() {
    this.inertia = new Matrix();
    this.inverseInertia = new Matrix();
  };
  Body.prototype.updateAngularVelocity = function updateAngularVelocity() {
    this.angularVelocity.set(this.inverseInertia.vectorMultiply(this.angularMomentum));
  };
  Body.prototype.toWorldCoordinates = function toWorldCoordinates(localPosition) {
    return this.pWorld.set(this.orientation.rotateVector(localPosition));
  };
  Body.prototype.getEnergy = function getEnergy() {
    return Particle.prototype.getEnergy.call(this) + 0.5 * this.inertia.vectorMultiply(this.angularVelocity).dot(this.angularVelocity);
  };
  Body.prototype.reset = function reset(p, v, q, L) {
    Particle.prototype.reset.call(this, p, v);
    this.angularVelocity.clear();
    this.setOrientation(q || [1, 0, 0, 0]);
    this.setAngularMomentum(L || [0, 0, 0]);
  };
  Body.prototype.setOrientation = function setOrientation(q) {
    this.orientation.set(q);
  };
  Body.prototype.setAngularVelocity = function setAngularVelocity(w) {
    this.wake();
    this.angularVelocity.set(w);
  };
  Body.prototype.setAngularMomentum = function setAngularMomentum(L) {
    this.wake();
    this.angularMomentum.set(L);
  };
  Body.prototype.applyForce = function applyForce(force, location) {
    Particle.prototype.applyForce.call(this, force);
    if (location !== undefined)
      this.applyTorque(location.cross(force));
  };
  Body.prototype.applyTorque = function applyTorque(torque) {
    this.wake();
    this.torque.set(this.torque.add(torque));
  };
  Body.prototype.getTransform = function getTransform() {
    return Transform.thenMove(this.orientation.getTransform(), Transform.getTranslate(Particle.prototype.getTransform.call(this)));
  };
  Body.prototype._integrate = function _integrate(dt) {
    Particle.prototype._integrate.call(this, dt);
    this.integrateAngularMomentum(dt);
    this.updateAngularVelocity(dt);
    this.integrateOrientation(dt);
  };
  Body.prototype.integrateAngularMomentum = function integrateAngularMomentum(dt) {
    Integrator.integrateAngularMomentum(this, dt);
  };
  Body.prototype.integrateOrientation = function integrateOrientation(dt) {
    Integrator.integrateOrientation(this, dt);
  };
  module.exports = Body;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/physics/constraints/index", ["npm:famous@0.3.5/physics/constraints/Collision", "npm:famous@0.3.5/physics/constraints/Constraint", "npm:famous@0.3.5/physics/constraints/Curve", "npm:famous@0.3.5/physics/constraints/Distance", "npm:famous@0.3.5/physics/constraints/Snap", "npm:famous@0.3.5/physics/constraints/Surface", "npm:famous@0.3.5/physics/constraints/Wall", "npm:famous@0.3.5/physics/constraints/Walls"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    Collision: require("npm:famous@0.3.5/physics/constraints/Collision"),
    Constraint: require("npm:famous@0.3.5/physics/constraints/Constraint"),
    Curve: require("npm:famous@0.3.5/physics/constraints/Curve"),
    Distance: require("npm:famous@0.3.5/physics/constraints/Distance"),
    Snap: require("npm:famous@0.3.5/physics/constraints/Snap"),
    Surface: require("npm:famous@0.3.5/physics/constraints/Surface"),
    Wall: require("npm:famous@0.3.5/physics/constraints/Wall"),
    Walls: require("npm:famous@0.3.5/physics/constraints/Walls")
  };
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/physics/forces/index", ["npm:famous@0.3.5/physics/forces/Drag", "npm:famous@0.3.5/physics/forces/Force", "npm:famous@0.3.5/physics/forces/Repulsion", "npm:famous@0.3.5/physics/forces/RotationalDrag", "npm:famous@0.3.5/physics/forces/RotationalSpring", "npm:famous@0.3.5/physics/forces/Spring", "npm:famous@0.3.5/physics/forces/VectorField"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    Drag: require("npm:famous@0.3.5/physics/forces/Drag"),
    Force: require("npm:famous@0.3.5/physics/forces/Force"),
    Repulsion: require("npm:famous@0.3.5/physics/forces/Repulsion"),
    RotationalDrag: require("npm:famous@0.3.5/physics/forces/RotationalDrag"),
    RotationalSpring: require("npm:famous@0.3.5/physics/forces/RotationalSpring"),
    Spring: require("npm:famous@0.3.5/physics/forces/Spring"),
    VectorField: require("npm:famous@0.3.5/physics/forces/VectorField")
  };
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/views/ScrollContainer", ["npm:famous@0.3.5/surfaces/ContainerSurface", "npm:famous@0.3.5/core/EventHandler", "npm:famous@0.3.5/views/Scrollview", "npm:famous@0.3.5/utilities/Utility", "npm:famous@0.3.5/core/OptionsManager"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var ContainerSurface = require("npm:famous@0.3.5/surfaces/ContainerSurface");
  var EventHandler = require("npm:famous@0.3.5/core/EventHandler");
  var Scrollview = require("npm:famous@0.3.5/views/Scrollview");
  var Utility = require("npm:famous@0.3.5/utilities/Utility");
  var OptionsManager = require("npm:famous@0.3.5/core/OptionsManager");
  function ScrollContainer(options) {
    this.options = Object.create(ScrollContainer.DEFAULT_OPTIONS);
    this._optionsManager = new OptionsManager(this.options);
    if (options)
      this.setOptions(options);
    this.container = new ContainerSurface(this.options.container);
    this.scrollview = new Scrollview(this.options.scrollview);
    this.container.add(this.scrollview);
    this._eventInput = new EventHandler();
    EventHandler.setInputHandler(this, this._eventInput);
    this._eventInput.pipe(this.scrollview);
    this._eventOutput = new EventHandler();
    EventHandler.setOutputHandler(this, this._eventOutput);
    this.container.pipe(this._eventOutput);
    this.scrollview.pipe(this._eventOutput);
  }
  ScrollContainer.DEFAULT_OPTIONS = {
    container: {properties: {overflow: 'hidden'}},
    scrollview: {}
  };
  ScrollContainer.prototype.setOptions = function setOptions(options) {
    return this._optionsManager.setOptions(options);
  };
  ScrollContainer.prototype.sequenceFrom = function sequenceFrom() {
    return this.scrollview.sequenceFrom.apply(this.scrollview, arguments);
  };
  ScrollContainer.prototype.getSize = function getSize() {
    return this.container.getSize.apply(this.container, arguments);
  };
  ScrollContainer.prototype.render = function render() {
    return this.container.render();
  };
  module.exports = ScrollContainer;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/widgets/index", ["npm:famous@0.3.5/widgets/NavigationBar", "npm:famous@0.3.5/widgets/Slider", "npm:famous@0.3.5/widgets/TabBar", "npm:famous@0.3.5/widgets/ToggleButton"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    NavigationBar: require("npm:famous@0.3.5/widgets/NavigationBar"),
    Slider: require("npm:famous@0.3.5/widgets/Slider"),
    TabBar: require("npm:famous@0.3.5/widgets/TabBar"),
    ToggleButton: require("npm:famous@0.3.5/widgets/ToggleButton")
  };
  global.define = __define;
  return module.exports;
});



(function() {
function define(){};  define.amd = {};
System.register("github:IjzerenHein/famous-flex@0.2.0/src/LayoutController", ["npm:famous@0.3.5/utilities/Utility", "npm:famous@0.3.5/core/Entity", "npm:famous@0.3.5/core/ViewSequence", "npm:famous@0.3.5/core/OptionsManager", "npm:famous@0.3.5/core/EventHandler", "github:IjzerenHein/famous-flex@0.2.0/src/LayoutUtility", "github:IjzerenHein/famous-flex@0.2.0/src/LayoutNodeManager", "github:IjzerenHein/famous-flex@0.2.0/src/LayoutNode", "github:IjzerenHein/famous-flex@0.2.0/src/FlowLayoutNode", "npm:famous@0.3.5/core/Transform", "github:IjzerenHein/famous-flex@0.2.0/src/helpers/LayoutDockHelper"], false, function(__require, __exports, __module) {
  return (function(require, exports, module) {
    var Utility = require("npm:famous@0.3.5/utilities/Utility");
    var Entity = require("npm:famous@0.3.5/core/Entity");
    var ViewSequence = require("npm:famous@0.3.5/core/ViewSequence");
    var OptionsManager = require("npm:famous@0.3.5/core/OptionsManager");
    var EventHandler = require("npm:famous@0.3.5/core/EventHandler");
    var LayoutUtility = require("github:IjzerenHein/famous-flex@0.2.0/src/LayoutUtility");
    var LayoutNodeManager = require("github:IjzerenHein/famous-flex@0.2.0/src/LayoutNodeManager");
    var LayoutNode = require("github:IjzerenHein/famous-flex@0.2.0/src/LayoutNode");
    var FlowLayoutNode = require("github:IjzerenHein/famous-flex@0.2.0/src/FlowLayoutNode");
    var Transform = require("npm:famous@0.3.5/core/Transform");
    require("github:IjzerenHein/famous-flex@0.2.0/src/helpers/LayoutDockHelper");
    function LayoutController(options, nodeManager) {
      this.id = Entity.register(this);
      this._isDirty = true;
      this._contextSizeCache = [0, 0];
      this._commitOutput = {};
      this._eventInput = new EventHandler();
      EventHandler.setInputHandler(this, this._eventInput);
      this._eventOutput = new EventHandler();
      EventHandler.setOutputHandler(this, this._eventOutput);
      this._layout = {options: Object.create({})};
      this._layout.optionsManager = new OptionsManager(this._layout.options);
      this._layout.optionsManager.on('change', function() {
        this._isDirty = true;
      }.bind(this));
      this.options = Object.create(LayoutController.DEFAULT_OPTIONS);
      this._optionsManager = new OptionsManager(this.options);
      if (nodeManager) {
        this._nodes = nodeManager;
      } else if (options && options.flow) {
        this._nodes = new LayoutNodeManager(FlowLayoutNode, _initFlowLayoutNode.bind(this));
      } else {
        this._nodes = new LayoutNodeManager(LayoutNode);
      }
      this.setDirection(undefined);
      if (options) {
        this.setOptions(options);
      }
    }
    LayoutController.DEFAULT_OPTIONS = {
      nodeSpring: {
        dampingRatio: 0.8,
        period: 300
      },
      reflowOnResize: true
    };
    function _initFlowLayoutNode(node, spec) {
      if (!spec && this.options.insertSpec) {
        node.setSpec(this.options.insertSpec);
      }
    }
    LayoutController.prototype.setOptions = function setOptions(options) {
      if ((options.alignment !== undefined) && (options.alignment !== this.options.alignment)) {
        this._isDirty = true;
      }
      this._optionsManager.setOptions(options);
      if (options.dataSource) {
        this.setDataSource(options.dataSource);
      }
      if (options.layout) {
        this.setLayout(options.layout, options.layoutOptions);
      } else if (options.layoutOptions) {
        this.setLayoutOptions(options.layoutOptions);
      }
      if (options.direction !== undefined) {
        this.setDirection(options.direction);
      }
      if (options.nodeSpring && this.options.flow) {
        this._nodes.setNodeOptions({spring: options.nodeSpring});
      }
      if (options.preallocateNodes) {
        this._nodes.preallocateNodes(options.preallocateNodes.count || 0, options.preallocateNodes.spec);
      }
      return this;
    };
    function _forEachRenderable(callback) {
      var dataSource = this._dataSource;
      if (dataSource instanceof Array) {
        for (var i = 0,
            j = dataSource.length; i < j; i++) {
          callback(dataSource[i]);
        }
      } else if (dataSource instanceof ViewSequence) {
        var renderable;
        while (dataSource) {
          renderable = dataSource.get();
          if (!renderable) {
            break;
          }
          callback(renderable);
          dataSource = dataSource.getNext();
        }
      } else {
        for (var key in dataSource) {
          callback(dataSource[key]);
        }
      }
    }
    LayoutController.prototype.setDataSource = function(dataSource) {
      this._dataSource = dataSource;
      this._nodesById = undefined;
      if (dataSource instanceof Array) {
        this._viewSequence = new ViewSequence(dataSource);
      } else if ((dataSource instanceof ViewSequence) || dataSource.getNext) {
        this._viewSequence = dataSource;
      } else if (dataSource instanceof Object) {
        this._nodesById = dataSource;
      }
      if (this.options.autoPipeEvents) {
        if (this._dataSource.pipe) {
          this._dataSource.pipe(this);
          this._dataSource.pipe(this._eventOutput);
        } else {
          _forEachRenderable.call(this, function(renderable) {
            if (renderable && renderable.pipe) {
              renderable.pipe(this);
              renderable.pipe(this._eventOutput);
            }
          }.bind(this));
        }
      }
      this._isDirty = true;
      return this;
    };
    LayoutController.prototype.getDataSource = function() {
      return this._dataSource;
    };
    LayoutController.prototype.setLayout = function(layout, options) {
      if (layout instanceof Function) {
        this._layout._function = layout;
        this._layout.capabilities = layout.Capabilities;
        this._layout.literal = undefined;
      } else if (layout instanceof Object) {
        this._layout.literal = layout;
        this._layout.capabilities = undefined;
        var helperName = Object.keys(layout)[0];
        var Helper = LayoutUtility.getRegisteredHelper(helperName);
        this._layout._function = Helper ? function(context, options2) {
          var helper = new Helper(context, options2);
          helper.parse(layout[helperName]);
        } : undefined;
      } else {
        this._layout._function = undefined;
        this._layout.capabilities = undefined;
        this._layout.literal = undefined;
      }
      if (options) {
        this.setLayoutOptions(options);
      }
      this.setDirection(this._configuredDirection);
      this._isDirty = true;
      return this;
    };
    LayoutController.prototype.getLayout = function() {
      return this._layout.literal || this._layout._function;
    };
    LayoutController.prototype.setLayoutOptions = function(options) {
      this._layout.optionsManager.setOptions(options);
      return this;
    };
    LayoutController.prototype.getLayoutOptions = function() {
      return this._layout.options;
    };
    function _getActualDirection(direction) {
      if (this._layout.capabilities && this._layout.capabilities.direction) {
        if (Array.isArray(this._layout.capabilities.direction)) {
          for (var i = 0; i < this._layout.capabilities.direction.length; i++) {
            if (this._layout.capabilities.direction[i] === direction) {
              return direction;
            }
          }
          return this._layout.capabilities.direction[0];
        } else {
          return this._layout.capabilities.direction;
        }
      }
      return (direction === undefined) ? Utility.Direction.Y : direction;
    }
    LayoutController.prototype.setDirection = function(direction) {
      this._configuredDirection = direction;
      var newDirection = _getActualDirection.call(this, direction);
      if (newDirection !== this._direction) {
        this._direction = newDirection;
        this._isDirty = true;
      }
    };
    LayoutController.prototype.getDirection = function(actual) {
      return actual ? this._direction : this._configuredDirection;
    };
    LayoutController.prototype.getSpec = function(node, normalize) {
      if (!node) {
        return undefined;
      }
      if ((node instanceof String) || (typeof node === 'string')) {
        if (!this._nodesById) {
          return undefined;
        }
        node = this._nodesById[node];
        if (!node) {
          return undefined;
        }
        if (node instanceof Array) {
          return node;
        }
      }
      if (this._specs) {
        for (var i = 0; i < this._specs.length; i++) {
          var spec = this._specs[i];
          if (spec.renderNode === node) {
            if (normalize && spec.transform && spec.size && (spec.align || spec.origin)) {
              var transform = spec.transform;
              if (spec.align && (spec.align[0] || spec.align[1])) {
                transform = Transform.thenMove(transform, [spec.align[0] * this._contextSizeCache[0], spec.align[1] * this._contextSizeCache[1], 0]);
              }
              if (spec.origin && (spec.origin[0] || spec.origin[1])) {
                transform = Transform.moveThen([-spec.origin[0] * spec.size[0], -spec.origin[1] * spec.size[1], 0], transform);
              }
              return {
                opacity: spec.opacity,
                size: spec.size,
                transform: transform
              };
            }
            return spec;
          }
        }
      }
      return undefined;
    };
    LayoutController.prototype.reflowLayout = function() {
      this._isDirty = true;
      return this;
    };
    LayoutController.prototype.insert = function(indexOrId, renderable, insertSpec) {
      if ((indexOrId instanceof String) || (typeof indexOrId === 'string')) {
        if (this._dataSource === undefined) {
          this._dataSource = {};
          this._nodesById = this._dataSource;
        }
        if (this._nodesById[indexOrId] === renderable) {
          return this;
        }
        this._nodesById[indexOrId] = renderable;
      } else {
        if (this._dataSource === undefined) {
          this._dataSource = [];
          this._viewSequence = new ViewSequence(this._dataSource);
        }
        var dataSource = this._viewSequence || this._dataSource;
        if (indexOrId === -1) {
          dataSource.push(renderable);
        } else if (indexOrId === 0) {
          if (dataSource === this._viewSequence) {
            dataSource.splice(0, 0, renderable);
            if (this._viewSequence.getIndex() === 0) {
              var nextViewSequence = this._viewSequence.getNext();
              if (nextViewSequence && nextViewSequence.get()) {
                this._viewSequence = nextViewSequence;
              }
            }
          } else {
            dataSource.splice(0, 0, renderable);
          }
        } else {
          dataSource.splice(indexOrId, 0, renderable);
        }
      }
      if (insertSpec) {
        this._nodes.insertNode(this._nodes.createNode(renderable, insertSpec));
      }
      if (this.options.autoPipeEvents && renderable && renderable.pipe) {
        renderable.pipe(this);
        renderable.pipe(this._eventOutput);
      }
      this._isDirty = true;
      return this;
    };
    LayoutController.prototype.push = function(renderable, insertSpec) {
      return this.insert(-1, renderable, insertSpec);
    };
    function _getViewSequenceAtIndex(index) {
      var viewSequence = this._viewSequence;
      var i = viewSequence ? viewSequence.getIndex() : index;
      if (index > i) {
        while (viewSequence) {
          viewSequence = viewSequence.getNext();
          if (!viewSequence) {
            return undefined;
          }
          i = viewSequence.getIndex();
          if (i === index) {
            return viewSequence;
          } else if (index < i) {
            return undefined;
          }
        }
      } else if (index < i) {
        while (viewSequence) {
          viewSequence = viewSequence.getPrevious();
          if (!viewSequence) {
            return undefined;
          }
          i = viewSequence.getIndex();
          if (i === index) {
            return viewSequence;
          } else if (index > i) {
            return undefined;
          }
        }
      }
      return viewSequence;
    }
    LayoutController.prototype.get = function(indexOrId) {
      if (this._nodesById || (indexOrId instanceof String) || (typeof indexOrId === 'string')) {
        return this._nodesById[indexOrId];
      }
      var viewSequence = _getViewSequenceAtIndex.call(this, indexOrId);
      return viewSequence ? viewSequence.get() : undefined;
    };
    LayoutController.prototype.swap = function(index, index2) {
      if (this._viewSequence) {
        _getViewSequenceAtIndex.call(this, index).swap(_getViewSequenceAtIndex.call(this, index2));
        this._isDirty = true;
      }
      return this;
    };
    LayoutController.prototype.replace = function(indexOrId, renderable) {
      var oldRenderable;
      if (this._nodesById || (indexOrId instanceof String) || (typeof indexOrId === 'string')) {
        oldRenderable = this._nodesById[indexOrId];
        this._nodesById[indexOrId] = renderable;
        this._isDirty = true;
        return oldRenderable;
      }
      return undefined;
    };
    LayoutController.prototype.remove = function(indexOrId, removeSpec) {
      var renderNode;
      if (this._nodesById || (indexOrId instanceof String) || (typeof indexOrId === 'string')) {
        if ((indexOrId instanceof String) || (typeof indexOrId === 'string')) {
          renderNode = this._nodesById[indexOrId];
          if (renderNode) {
            delete this._nodesById[indexOrId];
          }
        } else {
          for (var key in this._nodesById) {
            if (this._nodesById[key] === indexOrId) {
              delete this._nodesById[key];
              renderNode = indexOrId;
              break;
            }
          }
        }
      } else {
        if ((indexOrId instanceof Number) || (typeof indexOrId === 'number')) {
          if (this._dataSource instanceof Array) {
            renderNode = this._dataSource.splice(indexOrId, 1)[0];
          } else {
            renderNode = this._dataSource._.getValue(indexOrId);
            this._dataSource.splice(indexOrId, 1);
          }
        } else {
          indexOrId = this._dataSource.indexOf(indexOrId);
          if (indexOrId >= 0) {
            this._dataSource.splice(indexOrId, 1);
            renderNode = indexOrId;
          }
        }
      }
      if (renderNode && removeSpec) {
        var node = this._nodes.getNodeByRenderNode(renderNode);
        if (node) {
          node.remove(removeSpec || this.options.removeSpec);
        }
      }
      if (renderNode) {
        this._isDirty = true;
      }
      return this;
    };
    LayoutController.prototype.removeAll = function(removeSpec) {
      if (this._nodesById) {
        var dirty = false;
        for (var key in this._nodesById) {
          delete this._nodesById[key];
          dirty = true;
        }
        if (dirty) {
          this._isDirty = true;
        }
      } else if (this._dataSource) {
        this.setDataSource([]);
      }
      if (removeSpec) {
        var node = this._nodes.getStartEnumNode();
        while (node) {
          node.remove(removeSpec || this.options.removeSpec);
          node = node._next;
        }
      }
      return this;
    };
    LayoutController.prototype.getSize = function() {
      return this._size || this.options.size;
    };
    LayoutController.prototype.render = function render() {
      return this.id;
    };
    LayoutController.prototype.commit = function commit(context) {
      var transform = context.transform;
      var origin = context.origin;
      var size = context.size;
      var opacity = context.opacity;
      if (size[0] !== this._contextSizeCache[0] || size[1] !== this._contextSizeCache[1] || this._isDirty || this._nodes._trueSizeRequested || this.options.alwaysLayout) {
        var eventData = {
          target: this,
          oldSize: this._contextSizeCache,
          size: size,
          dirty: this._isDirty,
          trueSizeRequested: this._nodes._trueSizeRequested
        };
        this._eventOutput.emit('layoutstart', eventData);
        if (this.options.flow && (this._isDirty || (this.options.reflowOnResize && ((size[0] !== this._contextSizeCache[0]) || (size[1] !== this._contextSizeCache[1]))))) {
          var node = this._nodes.getStartEnumNode();
          while (node) {
            node.releaseLock();
            node = node._next;
          }
        }
        this._contextSizeCache[0] = size[0];
        this._contextSizeCache[1] = size[1];
        this._isDirty = false;
        var scrollEnd;
        if (this.options.size && (this.options.size[this._direction] === true)) {
          scrollEnd = 1000000;
        }
        var layoutContext = this._nodes.prepareForLayout(this._viewSequence, this._nodesById, {
          size: size,
          direction: this._direction,
          scrollEnd: scrollEnd
        });
        if (this._layout._function) {
          this._layout._function(layoutContext, this._layout.options);
        }
        this._nodes.removeNonInvalidatedNodes(this.options.removeSpec);
        this._nodes.removeVirtualViewSequenceNodes();
        if (scrollEnd) {
          scrollEnd = 0;
          node = this._nodes.getStartEnumNode();
          while (node) {
            if (node._invalidated && node.scrollLength) {
              scrollEnd += node.scrollLength;
            }
            node = node._next;
          }
          this._size = this._size || [0, 0];
          this._size[0] = this.options.size[0];
          this._size[1] = this.options.size[1];
          this._size[this._direction] = scrollEnd;
        }
        var result = this._nodes.buildSpecAndDestroyUnrenderedNodes();
        this._commitOutput.target = result.specs;
        this._eventOutput.emit('reflow', {target: this});
        this._eventOutput.emit('layoutend', eventData);
      } else if (this.options.flow) {
        result = this._nodes.buildSpecAndDestroyUnrenderedNodes();
        this._commitOutput.target = result.specs;
        if (result.modified) {
          this._eventOutput.emit('reflow', {target: this});
        }
      }
      this._specs = this._commitOutput.target;
      var target = this._commitOutput.target;
      for (var i = 0,
          j = target.length; i < j; i++) {
        target[i].target = target[i].renderNode.render();
      }
      if (origin && ((origin[0] !== 0) || (origin[1] !== 0))) {
        transform = Transform.moveThen([-size[0] * origin[0], -size[1] * origin[1], 0], transform);
      }
      this._commitOutput.size = size;
      this._commitOutput.opacity = opacity;
      this._commitOutput.transform = transform;
      return this._commitOutput;
    };
    module.exports = LayoutController;
  }).call(__exports, __require, __exports, __module);
});


})();
System.register("npm:famous@0.3.5/core/Context", ["npm:famous@0.3.5/core/RenderNode", "npm:famous@0.3.5/core/EventHandler", "npm:famous@0.3.5/core/ElementAllocator", "npm:famous@0.3.5/core/Transform", "npm:famous@0.3.5/transitions/Transitionable"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var RenderNode = require("npm:famous@0.3.5/core/RenderNode");
  var EventHandler = require("npm:famous@0.3.5/core/EventHandler");
  var ElementAllocator = require("npm:famous@0.3.5/core/ElementAllocator");
  var Transform = require("npm:famous@0.3.5/core/Transform");
  var Transitionable = require("npm:famous@0.3.5/transitions/Transitionable");
  var _zeroZero = [0, 0];
  var usePrefix = !('perspective' in document.documentElement.style);
  function _getElementSize() {
    var element = this.container;
    return [element.clientWidth, element.clientHeight];
  }
  var _setPerspective = usePrefix ? function(element, perspective) {
    element.style.webkitPerspective = perspective ? perspective.toFixed() + 'px' : '';
  } : function(element, perspective) {
    element.style.perspective = perspective ? perspective.toFixed() + 'px' : '';
  };
  function Context(container) {
    this.container = container;
    this._allocator = new ElementAllocator(container);
    this._node = new RenderNode();
    this._eventOutput = new EventHandler();
    this._size = _getElementSize.call(this);
    this._perspectiveState = new Transitionable(0);
    this._perspective = undefined;
    this._nodeContext = {
      allocator: this._allocator,
      transform: Transform.identity,
      opacity: 1,
      origin: _zeroZero,
      align: _zeroZero,
      size: this._size
    };
    this._eventOutput.on('resize', function() {
      this.setSize(_getElementSize.call(this));
    }.bind(this));
  }
  Context.prototype.getAllocator = function getAllocator() {
    return this._allocator;
  };
  Context.prototype.add = function add(obj) {
    return this._node.add(obj);
  };
  Context.prototype.migrate = function migrate(container) {
    if (container === this.container)
      return ;
    this.container = container;
    this._allocator.migrate(container);
  };
  Context.prototype.getSize = function getSize() {
    return this._size;
  };
  Context.prototype.setSize = function setSize(size) {
    if (!size)
      size = _getElementSize.call(this);
    this._size[0] = size[0];
    this._size[1] = size[1];
  };
  Context.prototype.update = function update(contextParameters) {
    if (contextParameters) {
      if (contextParameters.transform)
        this._nodeContext.transform = contextParameters.transform;
      if (contextParameters.opacity)
        this._nodeContext.opacity = contextParameters.opacity;
      if (contextParameters.origin)
        this._nodeContext.origin = contextParameters.origin;
      if (contextParameters.align)
        this._nodeContext.align = contextParameters.align;
      if (contextParameters.size)
        this._nodeContext.size = contextParameters.size;
    }
    var perspective = this._perspectiveState.get();
    if (perspective !== this._perspective) {
      _setPerspective(this.container, perspective);
      this._perspective = perspective;
    }
    this._node.commit(this._nodeContext);
  };
  Context.prototype.getPerspective = function getPerspective() {
    return this._perspectiveState.get();
  };
  Context.prototype.setPerspective = function setPerspective(perspective, transition, callback) {
    return this._perspectiveState.set(perspective, transition, callback);
  };
  Context.prototype.emit = function emit(type, event) {
    return this._eventOutput.emit(type, event);
  };
  Context.prototype.on = function on(type, handler) {
    return this._eventOutput.on(type, handler);
  };
  Context.prototype.removeListener = function removeListener(type, handler) {
    return this._eventOutput.removeListener(type, handler);
  };
  Context.prototype.pipe = function pipe(target) {
    return this._eventOutput.pipe(target);
  };
  Context.prototype.unpipe = function unpipe(target) {
    return this._eventOutput.unpipe(target);
  };
  module.exports = Context;
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/physics/bodies/index", ["npm:famous@0.3.5/physics/bodies/Body", "npm:famous@0.3.5/physics/bodies/Circle", "npm:famous@0.3.5/physics/bodies/Particle", "npm:famous@0.3.5/physics/bodies/Rectangle"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    Body: require("npm:famous@0.3.5/physics/bodies/Body"),
    Circle: require("npm:famous@0.3.5/physics/bodies/Circle"),
    Particle: require("npm:famous@0.3.5/physics/bodies/Particle"),
    Rectangle: require("npm:famous@0.3.5/physics/bodies/Rectangle")
  };
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/views/index", ["npm:famous@0.3.5/views/ContextualView", "npm:famous@0.3.5/views/Deck", "npm:famous@0.3.5/views/DrawerLayout", "npm:famous@0.3.5/views/EdgeSwapper", "npm:famous@0.3.5/views/FlexibleLayout", "npm:famous@0.3.5/views/Flipper", "npm:famous@0.3.5/views/GridLayout", "npm:famous@0.3.5/views/HeaderFooterLayout", "npm:famous@0.3.5/views/Lightbox", "npm:famous@0.3.5/views/RenderController", "npm:famous@0.3.5/views/ScrollContainer", "npm:famous@0.3.5/views/Scroller", "npm:famous@0.3.5/views/Scrollview", "npm:famous@0.3.5/views/SequentialLayout", "npm:famous@0.3.5/views/SizeAwareView"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    ContextualView: require("npm:famous@0.3.5/views/ContextualView"),
    Deck: require("npm:famous@0.3.5/views/Deck"),
    DrawerLayout: require("npm:famous@0.3.5/views/DrawerLayout"),
    EdgeSwapper: require("npm:famous@0.3.5/views/EdgeSwapper"),
    FlexibleLayout: require("npm:famous@0.3.5/views/FlexibleLayout"),
    Flipper: require("npm:famous@0.3.5/views/Flipper"),
    GridLayout: require("npm:famous@0.3.5/views/GridLayout"),
    HeaderFooterLayout: require("npm:famous@0.3.5/views/HeaderFooterLayout"),
    Lightbox: require("npm:famous@0.3.5/views/Lightbox"),
    RenderController: require("npm:famous@0.3.5/views/RenderController"),
    ScrollContainer: require("npm:famous@0.3.5/views/ScrollContainer"),
    Scroller: require("npm:famous@0.3.5/views/Scroller"),
    Scrollview: require("npm:famous@0.3.5/views/Scrollview"),
    SequentialLayout: require("npm:famous@0.3.5/views/SequentialLayout"),
    SizeAwareView: require("npm:famous@0.3.5/views/SizeAwareView")
  };
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/core/index", ["npm:famous@0.3.5/core/Context", "npm:famous@0.3.5/core/ElementAllocator", "npm:famous@0.3.5/core/ElementOutput", "npm:famous@0.3.5/core/Engine", "npm:famous@0.3.5/core/Entity", "npm:famous@0.3.5/core/EventEmitter", "npm:famous@0.3.5/core/EventHandler", "npm:famous@0.3.5/core/Group", "npm:famous@0.3.5/core/Modifier", "npm:famous@0.3.5/core/OptionsManager", "npm:famous@0.3.5/core/RenderNode", "npm:famous@0.3.5/core/Scene", "npm:famous@0.3.5/core/SpecParser", "npm:famous@0.3.5/core/Surface", "npm:famous@0.3.5/core/Transform", "npm:famous@0.3.5/core/View", "npm:famous@0.3.5/core/ViewSequence"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    Context: require("npm:famous@0.3.5/core/Context"),
    ElementAllocator: require("npm:famous@0.3.5/core/ElementAllocator"),
    ElementOutput: require("npm:famous@0.3.5/core/ElementOutput"),
    Engine: require("npm:famous@0.3.5/core/Engine"),
    Entity: require("npm:famous@0.3.5/core/Entity"),
    EventEmitter: require("npm:famous@0.3.5/core/EventEmitter"),
    EventHandler: require("npm:famous@0.3.5/core/EventHandler"),
    Group: require("npm:famous@0.3.5/core/Group"),
    Modifier: require("npm:famous@0.3.5/core/Modifier"),
    OptionsManager: require("npm:famous@0.3.5/core/OptionsManager"),
    RenderNode: require("npm:famous@0.3.5/core/RenderNode"),
    Scene: require("npm:famous@0.3.5/core/Scene"),
    SpecParser: require("npm:famous@0.3.5/core/SpecParser"),
    Surface: require("npm:famous@0.3.5/core/Surface"),
    Transform: require("npm:famous@0.3.5/core/Transform"),
    View: require("npm:famous@0.3.5/core/View"),
    ViewSequence: require("npm:famous@0.3.5/core/ViewSequence")
  };
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/physics/index", ["npm:famous@0.3.5/physics/PhysicsEngine", "npm:famous@0.3.5/physics/bodies/index", "npm:famous@0.3.5/physics/constraints/index", "npm:famous@0.3.5/physics/forces/index", "npm:famous@0.3.5/physics/integrators/index"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    PhysicsEngine: require("npm:famous@0.3.5/physics/PhysicsEngine"),
    bodies: require("npm:famous@0.3.5/physics/bodies/index"),
    constraints: require("npm:famous@0.3.5/physics/constraints/index"),
    forces: require("npm:famous@0.3.5/physics/forces/index"),
    integrators: require("npm:famous@0.3.5/physics/integrators/index")
  };
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5/index", ["npm:famous@0.3.5/core/index", "npm:famous@0.3.5/events/index", "npm:famous@0.3.5/inputs/index", "npm:famous@0.3.5/math/index", "npm:famous@0.3.5/modifiers/index", "npm:famous@0.3.5/physics/index", "npm:famous@0.3.5/surfaces/index", "npm:famous@0.3.5/transitions/index", "npm:famous@0.3.5/utilities/index", "npm:famous@0.3.5/views/index", "npm:famous@0.3.5/widgets/index"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    core: require("npm:famous@0.3.5/core/index"),
    events: require("npm:famous@0.3.5/events/index"),
    inputs: require("npm:famous@0.3.5/inputs/index"),
    math: require("npm:famous@0.3.5/math/index"),
    modifiers: require("npm:famous@0.3.5/modifiers/index"),
    physics: require("npm:famous@0.3.5/physics/index"),
    surfaces: require("npm:famous@0.3.5/surfaces/index"),
    transitions: require("npm:famous@0.3.5/transitions/index"),
    utilities: require("npm:famous@0.3.5/utilities/index"),
    views: require("npm:famous@0.3.5/views/index"),
    widgets: require("npm:famous@0.3.5/widgets/index")
  };
  global.define = __define;
  return module.exports;
});



System.register("npm:famous@0.3.5", ["npm:famous@0.3.5/index"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("npm:famous@0.3.5/index");
  global.define = __define;
  return module.exports;
});



System.register("Appview", ["npm:famous@0.3.5", "npm:famous@0.3.5/core/Engine", "npm:famous@0.3.5/core/Context", "npm:famous@0.3.5/core/Surface", "npm:famous@0.3.5/surfaces/ContainerSurface", "npm:famous@0.3.5/core/Transform", "github:IjzerenHein/famous-flex@0.2.0/src/LayoutController", "github:IjzerenHein/famous-flex@0.2.0/src/ScrollController", "github:IjzerenHein/famous-flex@0.2.0/src/layouts/CollectionLayout", "github:IjzerenHein/famous-flex@0.2.0/src/FlexScrollView", "github:IjzerenHein/famous-flex@0.2.0/src/layouts/ListLayout", "github:IjzerenHein/famous-flex@0.2.0/src/layouts/WheelLayout", "npm:famous@0.3.5/utilities/Utility", "npm:famous@0.3.5/core/Modifier", "npm:famous@0.3.5/core/RenderNode"], function($__export) {
  "use strict";
  var __moduleName = "Appview";
  var Famous,
      Engine,
      Context,
      Surface,
      ContainerSurface,
      Transform,
      LayoutController,
      ScrollController,
      CollectionLayout,
      FlexScrollView,
      ListLayout,
      WheelLayout,
      Utility,
      Modifier,
      RenderNode;
  return {
    setters: [function($__m) {
      Famous = $__m.default;
    }, function($__m) {
      Engine = $__m.default;
    }, function($__m) {
      Context = $__m.default;
    }, function($__m) {
      Surface = $__m.default;
    }, function($__m) {
      ContainerSurface = $__m.default;
    }, function($__m) {
      Transform = $__m.default;
    }, function($__m) {
      LayoutController = $__m.default;
    }, function($__m) {
      ScrollController = $__m.default;
    }, function($__m) {
      CollectionLayout = $__m.default;
    }, function($__m) {
      FlexScrollView = $__m.default;
    }, function($__m) {
      ListLayout = $__m.default;
    }, function($__m) {
      WheelLayout = $__m.default;
    }, function($__m) {
      Utility = $__m.default;
    }, function($__m) {
      Modifier = $__m.default;
    }, function($__m) {
      RenderNode = $__m.default;
    }],
    execute: function() {
      $__export('default', (function() {
        var AppView = function AppView() {
          this.mainContext = Engine.createContext();
          this._createLayout();
          this._fillLayout();
        };
        return ($traceurRuntime.createClass)(AppView, {
          _createLayout: function() {
            this.scrollView = new FlexScrollView({
              layout: ListLayout,
              flow: true,
              direction: 1,
              layoutOptions: {itemSize: 400}
            });
            this.horizontalScrollView = new FlexScrollView({
              layout: ListLayout,
              flow: true,
              mouseMove: true,
              direction: 0,
              touchMoveDirectionThresshold: 0.5,
              layoutOptions: {itemSize: 400},
              enabled: true
            });
            this.horzContainer = new ContainerSurface();
            this.horzContainer.add(this.horizontalScrollView);
            this.horzContainer.pipe(this.horizontalScrollView);
            this.container = new ContainerSurface();
            this.container.add(this.scrollView);
            this.container.pipe(this.scrollView);
            this.mainContext.setPerspective(500);
            this.mainContext.add(this.container);
          },
          _fillLayout: function() {
            this.scrollView.push(this._createCell("orange"), {opacity: 0});
            this.scrollView.push(this.horzContainer);
            this.scrollView.push(this._createCell("black"), {opacity: 0});
            this.scrollView.push(this._createCell("orange"), {opacity: 0});
            this.scrollView.push(this._createCell("blue"), {opacity: 0});
            this.scrollView.push(this._createCell("green"), {opacity: 0});
            this.scrollView.push(this._createCell("cyan"), {opacity: 0});
            this.scrollView.push(this._createCell("orange"), {opacity: 0});
            this.scrollView.push(this._createCell("red"), {opacity: 0});
            this.scrollView.push(this._createCell("black"), {opacity: 0});
            this.scrollView.push(this._createCell("blue"), {opacity: 0});
            this.horizontalScrollView.push(this._createCell2("hor1", "red"));
            this.horizontalScrollView.push(this._createCell2("hor2", "orange"));
            this.horizontalScrollView.push(this._createCell2("hor1", "red"));
            this.horizontalScrollView.push(this._createCell2("hor2", "orange"));
            this.horizontalScrollView.push(this._createCell2("hor1", "red"));
            this.horizontalScrollView.push(this._createCell2("hor2", "orange"));
            this.horizontalScrollView.push(this._createCell2("hor1", "red"));
            this.horizontalScrollView.push(this._createCell2("hor2", "orange"));
          },
          _createCell: function(color) {
            return new Surface({
              content: 'my section',
              size: [undefined, undefined],
              properties: {"background": color}
            });
          },
          _createCell2: function(title, color) {
            var surface = new Surface({
              content: title,
              size: [undefined, undefined],
              properties: {"background": color}
            });
            return surface;
          }
        }, {});
      }()));
    }
  };
});



System.register("main", ["Appview"], function($__export) {
  "use strict";
  var __moduleName = "main";
  var AppView;
  return {
    setters: [function($__m) {
      AppView = $__m.default;
    }],
    execute: function() {
      new AppView();
    }
  };
});



});
//# sourceMappingURL=bundle.js.map