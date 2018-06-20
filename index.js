var events = require('events');
var _ = require('lodash');
var fs = require('fs');
var path = require('path');
var async = require('async');
var ip = require('ip');
var dns = require('dns');
var uuid = require('node-uuid');
var dgram = require('dgram');
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
    self.on('message', function(message, remote) {
        self.logger.debug('\n'+message);
        self.extractCallId(message.toString(), function(err, callId) {
            if(err) {
                self.logger.error(err);
            }
            self.logger.debug(callId);
        });
    });
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
    self.generateReplacements(function(err, replacements) {
        if(err) {
            self.logger.error(err);
        }
        else {
            self.logger.info(JSON.stringify(replacements, undefined, 2));
            self.replacements = replacements;
            var server = dgram.createSocket('udp4');
            server.on('listening', function() {
                if(_.isString(self.file)) {
                    self.runSingleTestSuite(self.file, function(err) {
                        if(err) {
                            self.logger.error(err);
                        }
                        server.close();
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
                        server.close();
                    });
                }
            });
            server.on('message', function(message, remote) {
                self.emit('message', message, remote);
            });
            server.bind(self.lport);
        }
    });
};

Protos.prototype.runSingleTestSuite = function(file, callback) {
    var self = this;
    var tasks = [];
    tasks.push(function(callback) {
        fs.readFile(file, callback);
    });
    tasks.push(function(data, callback) {
        self.readTC(data, callback);
    });
    tasks.push(function(initPayload, tdPayload, callback) {
        self.applyReplacements(initPayload, tdPayload, callback);
    });
    tasks.push(function(initPayload, tdPayload, callback) {
        self.extractCallId(initPayload, function(err, callId) {
            callback(err, initPayload, tdPayload, callId);
        });
    });
    tasks.push(function(initPayload, tdPayload, callId, callback) {
        var client = dgram.createSocket('udp4');
        self.logger.debug('\n'+initPayload);
        self.logger.debug(callId);
        var initPayloadBuffer = new Buffer(initPayload);
        client.send(initPayloadBuffer, 0, initPayloadBuffer.length, self.dport, self.dhost, function(err, bytes) {
            setTimeout(function() {
                client.close();
                callback(err);
            }, 10000);
        });
    });
    async.waterfall(tasks, callback);
};

Protos.prototype.readTC = function(data, callback) {
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
    async.waterfall(tasks, callback);
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
            callback(undefined, payloadBuf.toString().trim(), size+offset);
        }
    }
};

Protos.prototype.applyReplacements = function(initPayload, tdPayload, callback) {
    var self = this;
    var tasks = [];
    tasks.push(function(callback) {
        async.eachOfSeries(self.replacements, function(val, key, callback) {
            initPayload = initPayload.replace(new RegExp('<'+key+'>', 'gm'), val);
            tdPayload = tdPayload.replace(new RegExp('<'+key+'>', 'gm'), val);
            callback();
        },
        function() {
            callback();
        });
    });
    tasks.push(function(callback) {
        var callId  = uuid.v4();
        var branchId = callId.replace(/-/g, '');
        initPayload = initPayload.replace(new RegExp('<Call-ID>', 'gm'), callId);
        tdPayload   = tdPayload.replace(new RegExp('<Call-ID>', 'gm'), callId);
        initPayload = initPayload.replace(new RegExp('<CSeq>', 'gm'), 1);
        tdPayload   = tdPayload.replace(new RegExp('<CSeq>', 'gm'), 2);
        initPayload = initPayload.replace(new RegExp('branch=z9hG4bK.*<Branch-ID>', 'gm'), 'branch=z9hG4bK'+branchId);
        tdPayload   = tdPayload.replace(new RegExp('branch=z9hG4bK.*<Branch-ID>', 'gm'), 'branch=z9hG4bK'+branchId);
        if(/<Content-Length>/.test(initPayload)) {
            var initSize = Protos.calcSize(initPayload);
            initPayload = initPayload.replace(new RegExp('<Content-Length>', 'gm'), initSize);
        }
        if(/<Content-Length>/.test(tdPayload)) {
            var tdSize = Protos.calcSize(tdPayload);
            tdPayload = tdPayload.replace(new RegExp('<Content-Length>', 'gm'), tdSize);
        }
        callback();
    });
    async.series(tasks, function(err) {
        callback(err, initPayload, tdPayload);
    });
};

Protos.prototype.generateReplacements = function(callback) {
    var self = this;
    var tasks = [];
    var replacements = {};
    var addrRegex = /^(?:([A-z0-9+_-]*)(?::([^@]*))?@)?([0-9A-z._-]*)(?::([0-9])*)?/;
    tasks.push(function(callback) {
        if(_.isString(self.touri)) {
            if(addrRegex.test(self.touri)) {
                var parsedToURI = self.touri.match(addrRegex);
                replacements.To = self.touri;
                replacements["To-User"] = parsedToURI[1];
                replacements["To-Pass"] = parsedToURI[2];
                replacements["To-Host"] = parsedToURI[3];
                replacements["To-Port"] = parsedToURI[4];
                self.dhost = parsedToURI[3];
                if(/^[0-9]*$/.test(replacements["To-Port"])) {
                    self.dport = parseInt(replacements["To-Port"], 10);
                }
                callback();
            }
            else {
                callback(new Error("Could not parse touri value"));
            }
        }
    });
    tasks.push(function(callback) {
        if(_.isString(self.fromuri)) {
            if(addrRegex.test(self.fromuri)) {
                var parsedFromURI = self.fromuri.match(addrRegex);
                replacements.From = self.fromuri;
                replacements["From-User"] = parsedFromURI[1];
                replacements["From-Pass"] = parsedFromURI[2];
                replacements["From-Host"] = parsedFromURI[3];
                replacements["From-Port"] = parsedFromURI[4];
                replacements["From-Address"] = parsedFromURI[3];
                if(/^[0-9]*$/.test(replacements["From-Port"])) {
                    self.lport = parseInt(replacements["From-Port"], 10);
                }
                callback();
            }
            else {
                callback(new Error("Could not parse fromuri value"));
            }
        }
        else {
            replacements["From-IP"] = ip.address();
            replacements["From-Address"] = ip.address();
            replacements.From = "user@"+ip.address();
            callback();
        }
    });
    tasks.push(function(callback) {
        if(!ip.isV4Format(replacements["From-Address"]) && !ip.isV4Format(replacements["From-Address"])) {
            dns.resolve4(replacements["From-Address"], function(err, ips) {
                if(err) {
                    callback(err);
                }
                else if(_.isString(ips) || (_.isArray(ips) && _.isString(_.last(ips)))) {
                    if(_.isArray(ips)) {
                        ips = _.last(ips);
                    }
                    if(ip.isV4Format(ips)) {
                        replacements["From-IP"] = ips;
                        callback();
                    }
                    else {
                        callback(new Error("Could not resolve From IP"));
                    }
                }
                else {
                    callback(new Error("Could not resolve From IP"));
                }
            });
        }
        else {
            replacements["From-IP"] = replacements["From-Address"];
            callback();
        }
    });
    tasks.push(function(callback) {
        replacements["Teardown-Method"] = "CANCEL";
        replacements["Local-Port"] = self.lport;
        callback();
    });
    async.series(tasks, function(err) {
        callback(err, replacements);
    });
};

Protos.calcSize = function(msg) {
    var msgArr = msg.split('\r\n');
    var startIdx = msgArr.indexOf("");
    if(startIdx < 0) {
        return 0;
    }
    else {
        var contentArr = msgArr.slice(startIdx);
        var size = contentArr.join('\r\n').length;
        return size;
    }
    return 0;
};
Protos.prototype.extractCallId = function(msg, callback) {
    var msgArr = msg.split('\r\n');
    async.detect(msgArr, function(line, callback) {
        callback(undefined, /^Call-ID:/i.test(line));
    },
    function(err, result) {
        if(err) {
            callback(err);
        }
        else {
            var cidRegex = /^Call-ID:(.*)$/;
            if(_.isString(result) && cidRegex.test(result)) {
                var cid = result.replace(cidRegex, "$1");
                cid = cid.trim();
                callback(undefined, cid);
            }
            else {
                callback(new Error("Could not find Call-ID in message"));
            }
        }
    });
};
