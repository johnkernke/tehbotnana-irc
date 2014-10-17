var EventEmitter= require('events').EventEmitter,
    net = require('net'),
    util = require('util'),
    irc_colors = ['white', 'black', 'blue', 'green', 'red', 'brown', 'purple', 'orange', 'yellow', 'lime', 'teal', 'cyan', 'royal', 'pink', 'grey', 'silver'];

function irc(config) {
    var self = this;

    self.connection;
    self.readBuffer = '';

    // setup the config
    self.config = {};
    self.config.host = config.host || '127.0.0.1';
    self.config.port = config.port || 6667;
    self.config.encoding = config.encoding || 'utf8';
    self.config.timeout = config.timeout || 7200000;
    self.config.nick = config.nick || 'TehBotnana';
    self.config.pass = config.pass || '';
    self.config.autoJoinChannels = config.autoJoinChannels || [];
    self.config.log = config.log || 'warning';

    var logger = new (require('logger'))(self.config.log, 'IRC');

    // connect to the IRC server
    self.connect = function () {
        logger.notice('Starting connection');
        self.connection = net.connect(self.config.port, self.config.host, self._onConnect);
        self.connection.setEncoding(self.config.encoding);
        self.connection.setTimeout(self.config.timeout);

        self.connection.on('data', self._onData);
        self.connection.on('end', self._onEOF);
        self.connection.on('timeout', self._onTimeout);
        self.connection.on('close', self._onClose);
    };

    // disconnect from the IRC server
    self.disconnect = function (reason) {
        // work out a better way to handle this so it fires for the first time each connection only
        if (self.connection.readable === true) {
            logger.notice('Disconnecting (' + reason + ')');
            self.connection.end();
            self.emit('disconnect');
        }
    };

    self._onConnect = function () {
        logger.notice('Connected');

        if (self.config.pass != '') {
            self._write('PASS ' + self.config.pass);
        }

        self._write('NICK ' + self.config.nick);
        self._write('USER ' + self.config.nick + ' 0 * :'+self.config.nick);

        self.emit('connect');
    };

    // on EOF, disconnect
    self._onEOF = function () {
        logger.debug('Event: EOF');
        self.disconnect('EOF');
    };

    // on Timeout, disconnect
    self._onTimeout = function () {
        logger.debug('Event: Timeout');
        self.disconnect('timeout');
    };

    // on Close, disconnect
    self._onClose = function () {
        logger.debug('Event: Close');
        self.disconnect('close');
    };

    // when we get data, get it a whole message then pass it on
    self._onData = function (chunk) {
        logger.debug('Event: Data recieved');
        self.readBuffer += chunk;

        while (self.readBuffer) {
            var offset = self.readBuffer.indexOf("\r\n");
            if (offset < 0) {
                return;
            }

            var message = self.readBuffer.slice(0, offset);
            self.readBuffer = self.readBuffer.slice(offset + 2);

            logger.debug('< ' + message);
            self._parse(message);
        }
    };

    // parse the message we have recieved
    self._parse = function (text) {
        if (typeof text !== 'string') {
            return false;
        }

        var arguments = text.split(' ');

        if (arguments.length < 2) {
            return false;
        }

        var messageObj = {
            prefix: null,
            command: null,
            args: [],
            original: text
        };

        for (var i in arguments) {
            if (i == 0 && arguments[i].indexOf(':') == 0) {
                messageObj.prefix = arguments[i].substr(1);
            } else if (arguments[i] == '') {
                continue;
            } else if (!messageObj.command && arguments[i].indexOf(':') != 0) {
                messageObj.command = arguments[i].toUpperCase();
            } else if (arguments[i].indexOf(':') == 0) {
                arguments[i] = arguments[i].substr(1);
                arguments.splice(0, i);
                messageObj.args.push(arguments.join(' '));
                break;
            } else {
                messageObj.args.push(arguments[i]);
            }
        }

        self._onMessage(messageObj);
    };

    // handle the incoming message
    self._onMessage = function (messageObj) {

        var target = messageObj.args[0],
            nick = self._parseIdent(messageObj.prefix),
            command = messageObj.command;

        switch (true) {
            case (command === 'PING'):
                self._write('PONG ' + messageObj.args.join(' '));
                break;

            case (command === '376'): // motd
                if (self.config.autoJoinChannels.length > 0) {
                    for (var i in self.config.autoJoinChannels) {
                        self.join(self.config.autoJoinChannels[i]);
                    }
                }
                self.emit('motd');
                break;

            case (command === 'PRIVMSG'):
                var channel = messageObj.args[0],
                    message = messageObj.args[1];
                if (message.substring(0, 1) == '!') {
                    // handle commands
                }

                if (channel.toLowerCase() === self.config.nick.toLowerCase()) {
                    self.emit('private_message', nick, message);
                } else {
                    self.emit('message', channel, nick, message);
                }
                break;

            case (command === 'JOIN'):
                var user = self._parseIdent(messageObj.prefix);
                logger.debug(user + ' joined channel ' + messageObj.args[0]);
                if (user.toLowerCase() === self.config.nick.toLowerCase()) {
                    self.emit('join-self', messageObj.args[0]);
                } else {
                    self.emit('join', messageObj.args[0], user);
                }
                break;

            case (command === 'PART'):
                logger.debug('Parted channel ' + messageObj.args[0]);
                self.emit('part', messageObj);
                break;

            case (command === 'QUIT'):
                self.emit('quit', messageObj);
                break;

            case (command === 'NICK'):
                self.emit('nick', messageObj);
                break;

            case (command === 'MODE'):
                self.emit('mode', messageObj.args[0], messageObj.args[1], messageObj.args[2]);
                break;

            case (command === '353'):
                self.emit('names', messageObj.args[2], messageObj.args[3].split(' '));
                break;

            case (/^\d+$/.test(command)):
                self.emit('numeric', messageObj);
                break;

            default:
                self.emit('other', messageObj);
        }
    };

    self._parseIdent = function (ident) {
        if (!ident) {
            return;
        }

        var match = ident.match(/^([^!]+)/);

        return match ? match[1] : false;
    };

    // write a raw message to the IRC server
    self._write = function (message) {
        if (self.connection.readable !== true) {
            return self.disconnect('Cannot send message when not connected.');
        }

        logger.debug('> ' + message);
        self.connection.write(message + "\r\n", this.encoding);
    };

    // send a message to the IRC server
    self.sendMessage = function (target, message) {
        // logger.notice('-> PRIVMSG ' + target + ' :' + message);
        self._write('PRIVMSG ' + target + ' :' + message);
    };

    // send a NAMES request
    self.getNames = function (channel) {
        self._write('NAMES ' + channel);
    };

    // connect to a channel
    self.join = function (channel) {
        self._write('JOIN ' + channel);
    };

    // color messages
    // fg/bg can be number or string matching irc_colors
    // bg is optional
    self.color = function (message, fg, bg) {
        fg = self._findColor(fg);
        bg = self._findColor(bg);

        if (fg != undefined) {
            if (bg != undefined) {
                return '\x03' + fg + ',' + bg + message + '\x03';
            }

            return '\x03' + fg + message + '\x03';
        }

        return message;
    };

    // alias for color
    self.colour = self.color;

    // make sure that a color is in irc_colors
    self._findColor = function (color) {
        if (typeof color == 'number' && color > -1 && color < irc_colors.length) {
            return color;
        } else if (typeof color == 'string') {
            color = irc_colors.indexOf(color);
            if (color != -1) {
                return color;
            }
        }

        return undefined;
    };

    // rever colours
    self.colorReverse = function () {
        return '\x16';
    };

    // bold
    self.bold = function (text) {
        return '\x02' + text + '\x02';
    };

    // italic
    self.italic = function (text) {
        return '\x1D' + text + '\x1D';
    };

    // underline
    self.underline = function (text) {
        return '\x1F' + text + '\x1F';
    };

    // reset the formatting?
    self.resetFormat = function () {
        return '\x0F';
    };
}

util.inherits(irc, EventEmitter);

module.exports = irc;
