/* */ 
var through = require("through"),
    esprima = require("esprima"),
    estraverse = require("estraverse"),
    escodegen = require("escodegen"),
    util = require("util");
module.exports = function(file) {
  var data = '';
  var stream = through(write, end);
  return stream;
  function write(buf) {
    data += buf;
  }
  function end() {
    var ast = esprima.parse(data),
        tast,
        isAMD = false;
    estraverse.replace(ast, {
      enter: function(node) {
        if (isDefine(node)) {
          var parents = this.parents();
          if (parents.length == 2 && parents[0].type == 'Program' && parents[1].type == 'ExpressionStatement') {
            isAMD = true;
          }
        }
      },
      leave: function(node) {
        if (isDefine(node)) {
          if (node.arguments.length == 1 && node.arguments[0].type == 'FunctionExpression') {
            var factory = node.arguments[0];
            if (factory.params.length == 0) {
              tast = createProgram(factory.body.body);
              this.break();
            } else if (factory.params.length > 0) {
              tast = createProgram(factory.body.body);
              this.break();
            }
          } else if (node.arguments.length == 1 && node.arguments[0].type == 'ObjectExpression') {
            var obj = node.arguments[0];
            tast = createModuleExport(obj);
            this.break();
          } else if (node.arguments.length == 2 && node.arguments[0].type == 'ArrayExpression' && node.arguments[1].type == 'FunctionExpression') {
            var dependencies = node.arguments[0],
                factory = node.arguments[1];
            var ids = dependencies.elements.map(function(el) {
              return el.value;
            });
            var vars = factory.params.map(function(el) {
              return el.name;
            });
            var reqs = createRequires(ids, vars);
            if (reqs) {
              tast = createProgram([reqs].concat(factory.body.body));
            } else {
              tast = createProgram(factory.body.body);
            }
            this.break();
          } else if (node.arguments.length == 3 && node.arguments[0].type == 'Literal' && node.arguments[1].type == 'ArrayExpression' && node.arguments[2].type == 'FunctionExpression') {
            var dependencies = node.arguments[1],
                factory = node.arguments[2];
            var ids = dependencies.elements.map(function(el) {
              return el.value;
            });
            var vars = factory.params.map(function(el) {
              return el.name;
            });
            var reqs = createRequires(ids, vars);
            if (reqs) {
              tast = createProgram([reqs].concat(factory.body.body));
            } else {
              tast = createProgram(factory.body.body);
            }
            this.break();
          }
        } else if (isReturn(node)) {
          var parents = this.parents();
          if (parents.length == 5 && isDefine(parents[2]) && isAMD) {
            return createModuleExport(node.argument);
          }
        }
      }
    });
    if (!isAMD) {
      stream.queue(data);
      stream.queue(null);
      return ;
    }
    tast = tast || ast;
    var out = escodegen.generate(tast);
    stream.queue(out);
    stream.queue(null);
  }
};
function isDefine(node) {
  var callee = node.callee;
  return callee && node.type == 'CallExpression' && callee.type == 'Identifier' && callee.name == 'define';
  ;
}
function isReturn(node) {
  return node.type == 'ReturnStatement';
}
function createProgram(body) {
  return {
    type: 'Program',
    body: body
  };
}
function createRequires(ids, vars) {
  var decls = [];
  for (var i = 0,
      len = ids.length; i < len; ++i) {
    if (['require', 'module', 'exports'].indexOf(ids[i]) != -1) {
      continue;
    }
    decls.push({
      type: 'VariableDeclarator',
      id: {
        type: 'Identifier',
        name: vars[i]
      },
      init: {
        type: 'CallExpression',
        callee: {
          type: 'Identifier',
          name: 'require'
        },
        arguments: [{
          type: 'Literal',
          value: ids[i]
        }]
      }
    });
  }
  if (decls.length == 0) {
    return null;
  }
  return {
    type: 'VariableDeclaration',
    declarations: decls,
    kind: 'var'
  };
}
function createModuleExport(obj) {
  return {
    type: 'ExpressionStatement',
    expression: {
      type: 'AssignmentExpression',
      operator: '=',
      left: {
        type: 'MemberExpression',
        computed: false,
        object: {
          type: 'Identifier',
          name: 'module'
        },
        property: {
          type: 'Identifier',
          name: 'exports'
        }
      },
      right: obj
    }
  };
}
