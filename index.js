var events = require('events');
var _ = require('lodash');
var fs = require('fs');
var path = require('path');
var async = require('async');
module.exports = Protos;

function Protos(options, logger) {
    var self = this;
    _.each(Protos.options, function(val, key) {
        if(_.isArray(val)) {
            self[key] = val[3];
        }
    });
    _.extend(self, options);
    if(_.isUndefined(logger)) {
        logger = console;
    }
    Protos.extendLogger(logger);
    self.logger = logger;
    self.lastIdx = Protos.lastTestCase();
    if(!_.isNumber(self.stop)) {
        self.stop = self.lastIdx;
    }
    if(_.isNumber(self.single)) {
        self.start = self.single;
        self.stop = self.single;
    }
    events.EventEmitter.call(this);
}

Protos.super_ = events.EventEmitter;
Protos.prototype = Object.create(events.EventEmitter.prototype, {
    constructor: {
        value: Protos,
        enumerable: false
    }
});

Protos.options = {
    touri:      ['t', "Recipient of the request", "string"],
    fromuri:    ['f', "Initiator of the request", "string"],
    sendto:     ['s', "Send packets to domain instead of domain name of -touri", "string"],
    callid:     ['c', "Call id to start test-case call ids from", "string", "0"],
    dport:      ['p', "Portnumber to send packets on host.", "int", 5060],
    lport:      ['l', "Portnumber to send packets from.", "int", 5060],
    delay:      ['d', "Time in ms to wait before sending new test-case", "int", 100],
    replywait:  ['r', "Maximum time in ms to wait for host to reply", "int", 100],
    file:       ['F', "Send file instead of testcases", "file"],
    showreply:  ['R', "Show received packets", "bool", false],
    showsent:   ['S', "Show sent packets", "bool", false],
    teardown:   ['T', "Send CANCEL/ACK", "bool", false],
    single:     [false, "Inject a single test-case", "int"],
    start:      [false, "Inject test-cases starting from <index>", "int", 0],
    stop:       [false, "Stop test-case injection at index", "int"],
    maxpdusize: ['m', "Maximum PDU size", "int", 65507],
    validcase:  ['V', "Send valid case (case #0) after each test-case and wait for a response. May be used to check if the target is still responding.", "bool", false]
};

// I have three different loggers with slightly different functions available I
// want to support, so if any of the log levels don't exist for the given
// logger, I fall back to `info` which is on all of them.
Protos.extendLogger = function(logger) {
    var loggerFuncs = [
        "ok",
        "debug",
        "info",
        "warn",
        "error",
        "fatal"
    ];
    _.each(loggerFuncs, function(x) {
        if(!_.isFunction(logger[x])) {
            logger[x] = logger.info;
        }
    });
};

Protos.lastTestCase = function() {
    var lastFileName = _.last(fs.readdirSync(path.join(__dirname, 'testcases')));
    if(_.isString(lastFileName) && /^[0-9]*$/.test(lastFileName)) {
        return parseInt(lastFileName, 10);
    }
    else {
        return null;
    }
};

Protos.prototype.run = function() {
    var self = this;
    if(_.isString(self.file)) {
        self.runSingleTestSuite(self.file, function(err) {
            if(err) {
                self.logger.error(err);
            }
        });
    }
    else {
        async.eachSeries(_.range(self.start, self.stop+1), function(idx, callback) {
            var filename = 'testcases/'+(('0000000'+idx).slice(-7));
            self.runSingleTestSuite(filename, function(err) {
                if(err) {
                    self.logger.error(err);
                }
                callback();
            });
        },
        function(err, results) {
        });
    }
};

Protos.prototype.runSingleTestSuite = function(file, callback) {
    var self = this;
    var tasks = [];
    tasks.push(function(callback) {
        self.logger.info(file);
        fs.readFile(file, callback);
    });
    tasks.push(function(data, callback) {
        self.parseFile(data, callback);
    });
    async.waterfall(tasks, callback);
};

Protos.prototype.parseFile = function(data, callback) {
    var self = this;
    var tasks = [];
    tasks.push(function(callback) {
        self.readTCSection(data, 0, callback);
    });
    tasks.push(function(initPayload, offset, callback) {
        self.readTCSection(data, offset, function(err, tdPayload) {
            callback(err, initPayload, tdPayload);
        });
    });
    async.waterfall(tasks, function(err, initPayload, tdPayload) {
        if(err) {
            callback(err);
        }
        else {
            callback();
        }
    });
};

Protos.prototype.readTCSection = function(data, offset, callback) {
    var self = this;
    var sizeString = "";
    var char;
    var charInt;
    do {
        charInt = data[offset++];
        if(_.isUndefined(charInt)) {
            callback(new Error("Unable to read payload size"));
            return;
        }
        if(charInt !== 32) {
            char = String.fromCharCode(charInt);
            sizeString += char;
        }
    } while(charInt !== 32);
    if(/^[0-9]*$/.test(sizeString)) {
        var size = parseInt(sizeString, 10);
        if(size+offset>data.length) {
            callback(new Error("Reported size is greater than data in file"));
            return;
        }
        else {
            var payloadBuf = Buffer.alloc(size);
            data.copy(payloadBuf, 0, offset, size+offset);
            callback(undefined, payloadBuf.toString(), size+offset);
        }
    }
};
