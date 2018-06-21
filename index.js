var events = require('events');
var _ = require('lodash');
var fs = require('fs');
var path = require('path');
var async = require('async');
var ip = require('ip');
var dns = require('dns');
var uuid = require('node-uuid');
var dgram = require('dgram');
var cb = require('cb');
var hexdump = require('@buzuli/hexdump');
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
        if(self.showreply) {
            self.logger.info('\n'+hexdump(message));
        }
        self.logger.debug('\n'+message);
        Protos.extractCallId(message.toString(), function(err, callId) {
            if(err) {
                self.logger.error(err);
            }
            self.emit(callId, message, remote);
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
    validcase:  ['V', "Send valid case (case #0) after each test-case and wait for a response. May be used to check if the target is still responding.", "bool", false],
    exit:       ['x', "Exit if the validation check fails after any test"]
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

Protos.prototype.run = function(callback) {
    var self = this;
    var failedTests = [];
    self.generateReplacements(function(err, replacements) {
        if(err) {
            callback(err);
        }
        else {
            self.replacements = replacements;
            var server = dgram.createSocket({type: 'udp4', recvBufferSize: self.maxpdusize});
            server.on('listening', function() {
                if(_.isString(self.file)) {
                    self.runSingleTestSuite(self.file, false, function(err, passed) {
                        if(passed === false) {
                            failedTests.push(self.file);
                        }
                        server.close();
                        callback(err, failedTests);
                    });
                }
                else {
                    async.eachSeries(_.range(self.start, self.stop+1), function(idx, callback) {
                        var filename = 'testcases/'+(('0000000'+idx).slice(-7));
                        self.runSingleTestSuite(filename, false, function(err, passed) {
                            if(passed === false) {
                                failedTests.push(filename);
                            }
                            if(err && self.exit) {
                                callback(err);
                            }
                            else {
                                setTimeout(callback, self.delay);
                            }
                        });
                    },
                    function(err, results) {
                        server.close();
                        callback(err, failedTests);
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

Protos.prototype.runSingleTestSuite = function(file, runningValidation, callback) {
    var self = this;
    var tasks = [];
    var fileName = path.basename(file);
    var testNum;
    // validationFailed variable is set when we are running the validation step
    // and is passed back to the nested call
    var validationFailed = false;
    // testPassed variable is set on the outer function run when we detect the
    // inner validation step has failed.
    var testPassed;
    if(/^[0-9]*$/.test(fileName)) {
        testNum = parseInt(fileName, 10);
    }
    else {
        testNum = 0;
    }
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
        Protos.extractCallId(initPayload, function(err, callId) {
            callback(err, initPayload, tdPayload, callId);
        });
    });
    tasks.push(function(initPayload, tdPayload, callId, callback) {
        if(runningValidation) {
            self.logger.info("Sending valid-case");
        }
        else {
            self.logger.info("Sending Test-Case #"+testNum);
        }
        self.processSip(initPayload, callId, testNum, function(err, statusObj) {
            if(runningValidation) {
                if(err || statusObj.statusCode !== 200) {
                    validationFailed = true;
                }
                callback(undefined, initPayload, tdPayload, callId);
            }
            else {
                if(_.isObject(err) && _.isString(err.name) && err.name === "TimeoutError") {
                    callback(undefined, initPayload, tdPayload, callId);
                }
                else {
                    callback(err, initPayload, tdPayload, callId);
                }
            }
        });
    });
    if(self.teardown) {
        tasks.push(function(initPayload, tdPayload, callId, callback) {
            self.logger.info(" Sending CANCEL");
            self.processSip(tdPayload, callId, testNum, function(err, statusObj) {
                if(_.isObject(err) && _.isString(err.name) && err.name === "TimeoutError") {
                    callback(undefined, initPayload, tdPayload, callId);
                }
                else {
                    callback(err, initPayload, tdPayload, callId);
                }
            });
        });
    }
    if(self.validcase && !runningValidation) {
        tasks.push(function(initPayload, tdPayload, callId, callback) {
            setTimeout(function() {
                self.runSingleTestSuite('testcases/0000000', true, function(err) {
                    if(err) {
                        testPassed = false;
                        if(self.exit) {
                            callback(err, initPayload, tdPayload, callId);
                        }
                        else {
                            callback(undefined, initPayload, tdPayload, callId);
                        }
                    }
                    else {
                        testPassed = true;
                        callback(err, initPayload, tdPayload, callId);
                    }
                });
            }, self.delay);
        });
    }
    async.waterfall(tasks, function(err) {
        if(err) {
            callback(err, false);
        }
        else if(runningValidation && validationFailed === true) {
            var error = new Error("Test failed validation.");
            error.code = "ValidationFailed";
            callback(error);
        }
        else {
            callback(undefined, testPassed);
        }
    });
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
        if(initPayload.slice(-4) !== '\r\n\r\n') {
            initPayload += '\r\n\r\n';
        }
        if(tdPayload.slice(-4) !== '\r\n\r\n') {
            tdPayload += '\r\n\r\n';
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
                if(!_.isString(self.sendto)) {
                    self.sendto = parsedToURI[3];
                }
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
Protos.extractCallId = function(msg, callback) {
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
Protos.extractResponse = function(msg) {
    var statusRegex = /^SIP\/([0-9.]*) ([1-6][0-9]{2})( (.*))?$/;
    var statusLine = _.first(msg.split('\r\n', 1)).trim();
    if(statusRegex.test(statusLine)) {
        var parsedStatus = statusLine.match(statusRegex);
        return {
            version: parsedStatus[1],
            statusCode: parseInt(parsedStatus[2], 10),
            statusMsg: parsedStatus[3]
        };
    }
};

Protos.prototype.processSip = function(payload, callId, testNum, callback) {
    var self = this;
    var method = Protos.extractMethod(payload);
    callback = cb(callback).once().timeout(self.replywait);
    self.on(callId, function(message, remote) {
        var csMethod = Protos.extractCSeqMethod(message.toString());
        if(csMethod === method || csMethod === "INVITE") {
            var statusObj = Protos.extractResponse(message.toString());
            if(_.isObject(statusObj) && _.isNumber(statusObj.statusCode)) {
                self.logger.info("   Received Returncode: "+statusObj.statusCode+" "+statusObj.statusMsg);
                switch(Math.floor(statusObj.statusCode/100)) {
                    case 1:
                    break;
                    case 2:
                    case 4:
                    case 5:
                        if(method === "INVITE") {
                            self.removeAllListeners(callId);
                            callback(undefined, statusObj);
                        }
                        else if(method === "CANCEL") {
                            var ackPayload = payload.replace(/CANCEL/gm, 'ACK');
                            self.logger.info(" Sending ACK");
                            self.sendMessage(ackPayload, testNum, function(err) {
                                self.removeAllListeners(callId);
                                callback(err, statusObj);
                            });
                        }
                    break;
                    case 3:
                    break;
                    case 6:
                    break;
                    default:
                        self.logger.error("Unknown status:"+statusObj.statusCode+" "+statusObj.statusMsg);
                    break;
                }
            }
        }
    });
    self.sendMessage(payload, testNum, function(err) {
        if(err) {
            callback(err);
        }
    });
};

Protos.prototype.sendMessage = function(payload, testNum, callback) {
    var self = this;
    var buf = Buffer.from(payload);
    var bufsize = Math.min(payload.length, self.maxpdusize);
    var client = dgram.createSocket({type: 'udp4', sendBufferSize: self.maxpdusize});
    var truncBuf = Buffer.alloc(bufsize);
    buf.copy(truncBuf, 0, 0, bufsize);
    self.logger.debug(truncBuf.toString());
    if(self.showsent) {
        self.logger.info('\n'+hexdump(truncBuf));
    }
    client.send(truncBuf, 0, truncBuf.length, self.dport, self.sendto, function(err, bytes) {
        self.logger.info("    test-case #"+testNum+", "+bytes+" bytes");
        client.close();
        callback(err);
    });
};

Protos.extractMethod = function(payload) {
    var firstLine = _.first(payload.split('/r/n'));
    var methodRegex = /^(INVITE|ACK|BYE|CANCEL|REGISTER|OPTIONS|PRACK|SUBSCRIBE|NOTIFY|PUBLISH|INFO|REFER|MESSAGE|UPDATE)/i;
    if(methodRegex.test(firstLine)) {
        return firstLine.match(methodRegex)[1];
    }
    else {
        return "UNKNOWN";
    }
};

Protos.extractCSeqMethod = function(payload) {
    var payloadArr = payload.split('\r\n');
    var CSeqLine = _.find(payloadArr, function(line) {
        return /^CSeq:/i.test(line);
    });
    var csmRegex = /(INVITE|ACK|BYE|CANCEL|REGISTER|OPTIONS|PRACK|SUBSCRIBE|NOTIFY|PUBLISH|INFO|REFER|MESSAGE|UPDATE)$/i;
    if(csmRegex.test(CSeqLine)) {
        return CSeqLine.match(csmRegex)[1];
    }
};
