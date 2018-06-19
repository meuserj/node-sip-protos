var cli = require('cli');
var path = require('path');
var _ = require('lodash');
var Protos = require('./index.js');

var OPTIONS = Protos.options;

exports.interpret = function(args) {
    cli.enable("help", "version", "status", "catchall");
    cli.option_width = 28;
    cli.setApp(path.resolve('./package.json'));
    cli.setArgv(args);
    var options = cli.parse(OPTIONS);
    if(!_.isString(options.touri)) {
        cli.getUsage();
    }
    else {
        var protos = new Protos(options, cli);
        protos.run();
    }
};
