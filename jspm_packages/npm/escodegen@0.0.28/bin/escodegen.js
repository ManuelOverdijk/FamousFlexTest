/* */ 
(function(process) {
  var fs = require("fs"),
      path = require("path"),
      root = path.join(path.dirname(fs.realpathSync(__filename)), '..'),
      esprima = require("esprima"),
      escodegen = require(root),
      files = process.argv.splice(2);
  if (files.length === 0) {
    console.log('Usage:');
    console.log('   escodegen file.js');
    process.exit(1);
  }
  files.forEach(function(filename) {
    var content = fs.readFileSync(filename, 'utf-8');
    console.log(escodegen.generate(esprima.parse(content)));
  });
})(require("process"));
