/**
 * Manages the IRC networks
 * Singleton implementation
 * @see http://stackoverflow.com/a/26227662
 * @todo real time notification
 * @todo modify download queue
 * @module SlingManager
 */

"use strict";

/** Module dependencies. */
const _ = require("lodash"),
    Axdcc = require("axdcc"),
    winston = require("winston"),
    sc = require("./SlingConfig"),
    SlingIrc = require("./SlingIrc"),
    SlingLogger = require("./SlingLogger"),
    SlingDB = require("./SlingDB"),
    async = require("async");

/**
 * Private members.
 * @static
 * @private
 */
const singleton = Symbol(),
    singletonEnforcer = Symbol(),
    networks = new Map(),
    db = new SlingDB(),
    finished = new Set();

/**
 * Event handler object.
 * @private
 */
const handle = {};

/**
 * Axdcc handler reaction for "connect"
 * @public
 */
handle.xdccConnect = function (dbpack, pack) {
    let nw = networks.get(dbpack.network),
        xdcc = nw.xdcc[dbpack.bot];

    if(sc.settings.get("xdcc:checkFilename")){
        if(pack.fileName != dbpack.name){
            winston.error(`Filename missmatch. requested: ${dbpack.name} - recieved: ${pack.fileName}`, pack);
            xdcc[0].xdcc.emit("cancel");
            return;
        }
    }


    winston.debug("SlingManager xdcc connect:", pack);
    //TODO: we need some notification mechanism here
};

/**
 * Axdcc handler reaction for "progress"
 * @public
 */
handle.xdccProgress = function (dbpack, pack) {
    let nw = networks.get(dbpack.network),
        xdcc = nw.xdcc[dbpack.bot];

    if (pack.status == "canceled") {
        xdcc.shift();
        if (xdcc.length >= 1) {
            xdcc[0].xdcc.emit("start");
        } else {
            delete nw.xdcc[dbpack.bot];
        }
        const settingsArr = sc.dl.get(`${dbpack.network}:${dbpack.bot}`) || [];
        settingsArr.shift();
        sc.dl.set(`${dbpack.network}:${dbpack.bot}`, settingsArr);
        sc.dl.save();
    }

    winston.debug("SlingManager xdcc progress:", pack);
    //TODO: we need some notification mechanism here
};

/**
 * Axdcc handler reaction for "message"
 * @public
 */
handle.xdccMessage = function (dbpack, pack, message) {
    winston.debug("SlingManager xdcc message:", pack, message);
    //TODO: we need some notification mechanism here
};

/**
 * Axdcc handler reaction for "complete"
 * @public
 */
handle.xdccComplete = function (dbpack, pack) {
    let nw = networks.get(dbpack.network),
        xdcc = nw.xdcc[dbpack.bot],
        request = xdcc.shift();
    request.notices = request.xdcc.notices;
    delete request.xdcc;
    finished.add(request);
    if (xdcc.length >= 1) {
        xdcc[0].xdcc.emit("start");
    } else {
        delete nw.xdcc[dbpack.bot];
    }
    const settingsArr = sc.dl.get(`${dbpack.network}:${dbpack.bot}`) || [];
    settingsArr.shift();
    sc.dl.set(`${dbpack.network}:${dbpack.bot}`, settingsArr);
    sc.dl.save();

    winston.debug("SlingManager xdcc complete:", pack);
    //TODO: we need some notification mechanism here
};

/**
 * Axdcc handler reaction for "error"
 * @public
 */
handle.xdccError = function (dbpack, pack, error) {
    let nw = networks.get(dbpack.network),
        xdcc = nw.xdcc[dbpack.bot],
        request = xdcc.shift();
    request.xdcc.emit("kill");
    delete request.xdcc;
    this.addDownload(request.id); //re-queue the download
    if (xdcc.length >= 1) {
        xdcc[0].xdcc.emit("start");
    } else {
        delete nw.xdcc[dbpack.bot];
    }

    const settingsArr = sc.dl.get(`${dbpack.network}:${dbpack.bot}`) || [];
    settingsArr.shift();
    sc.dl.set(`${dbpack.network}:${dbpack.bot}`, settingsArr);
    sc.dl.save();

    winston.error("SlingManager xdcc error:", pack, error);
    //TODO: we need some notification mechanism here
};

/**
 * SlingManager class. Manages the IRC networks
 * @class SlingManager
 */
class SlingManager {

    /**
     * DON'T CALL THIS YOURSELF!
     * @param {Symbol} enforcer
     * @constructs SlingManager
     * @throws Error on external call!
     * @private
     */
    constructor(enforcer) {
        if (enforcer != singletonEnforcer) throw "Cannot construct singleton";
        this.boot();
    }

    /**
     * gets the SlingManager instance
     * @return {SlingManager}
     * @throws Error on not initialized!
     * @public
     */
    static get instance() {
        if (!this[singleton]) {
            this[singleton] = new SlingManager(singletonEnforcer);
        }
        return this[singleton];
    }

    /**
     * Adds a network.
     * @param {string} network - unique name of the network
     * @param {string} hostname - Irc server hostname
     * @param {string} [opts.nick] - Nickname
     * @param {SlingChannel[]} [opts.channels] - Array of channels to join
     * @param {Object} [opts.options] - Settings object from node-irc, channels will be ignored
     * @param {String[]} [opts.commands] - Array with a sequence of irc commands (eg. ["/msg nickserv identify xyz"])
     * @throws Error - on invalid parameter
     * @throws Error - on used network name
     * @public
     */
    addNetwork(network, hostname, opts) {

        if (!_.isString(network)) {
            throw new Error("network must a string");
        }
        if (networks.has(network)) {
            throw new Error("network name not unique");
        }

        let logger = new SlingLogger(network)
            , options = _.clone(opts);

        options.onPackinfo = (packData, channel, nick) => {
            let id = packData.id,
                fileName = packData.fileName;
            delete packData.id;
            delete packData.fileName;
            logger.addPack(id, nick, fileName, packData);
        };

        let irc = new SlingIrc(hostname, options);

        networks.set(network, {irc: irc, logger: logger, xdcc: {}});
        winston.debug("SlingManager network added:", network);

        sc.nw.set(network, {
            hostname: hostname,
            opts: opts
        });
        sc.nw.save();

        return irc;
    }

    /**
     * Gets a network
     * @param {string} network - unique name of the network
     * @throws Error - on unknown network
     * @public
     */
    getNetwork(network) {
        if (networks.has(network)) {
            return networks.get(network);
        }
        throw new Error("unknown network");
    }

    /**
     * Remove a network
     * @param {string} network - unique name of the network
     * @param {boolean} [flush] - if this is set true all packets will deleted from database
     * @param {function} [cb] - optional callback (error, numRemoved)
     * @throws Error - on unknown network
     * @public
     */
    removeNetwork(network, flush, cb) {
        if (!networks.has(network)) {
            throw new Error("unknown network");
        }
        const nw = networks.get(network);

        //check for pending downloads
        if (_.size(nw.xdcc) > 0) {
            throw new Error("downloads pending");
        }

        if (_.isFunction(flush) && _.isUndefined(cb)) {
            cb = flush;
            flush = false;
        }

        async.parallel([
            (callback) => {
                //disconnect the irc client
                nw.irc.client.disconnect("bye", ()=> {
                    callback();
                });
            },
            (callback) => {
                if (flush) {
                    //flush the database
                    nw.logger.removeAll(callback);
                } else {
                    callback();
                }
            }
        ], (err, result) => {
            if (!err) {
                //if no error delete the network
                networks.delete(network);
                sc.nw.clear(network);
                sc.nw.save();
            }

            cb(err, result);
        });
    }


    /**
     * adds a new channel or replaces an existing.
     * @param {string} network - unique name of the network
     * @params {SlingChannel} channel - channel to add
     * @params {function} cb - callback
     * @throws Error - on unknown network
     * @public
     */
    addChannel(network, channel, cb) {
        if (!networks.has(network)) {
            throw new Error("unknown network");
        }
        const irc = networks.get(network).irc;
        irc.addChannel(channel, cb);
        sc.nw.set("${network}:opts:channels", irc.chans);
        sc.nw.save();
    }

    /**
     * removes an channel.
     * @param {string} network - unique name of the network
     * @params {SlingChannel} channel - channel to remove
     * @params {function} cb - callback
     * @throws Error - on unknown network
     * @throws Error - on unknown channel
     * @public
     */
    removeChannel(network, channel, cb) {
        if (!networks.has(network)) {
            throw new Error("unknown network");
        }
        const irc = networks.get(network).irc;
        irc.removeChannel(channel, cb);
        sc.nw.set("${network}:opts:channels", irc.chans);
        sc.nw.save();
    }

    /**
     * Adds a download
     * @param {string} id - id of the packet
     * @param {boolean} [dontPersist = false] - skips the saving
     * @param {function} [cb] - optional callback (error, info)
     * @throws Error - on unknown network
     * @public
     */
    addDownload(id, dontPersist, cb) {
        if (_.isFunction(dontPersist) && _.isUndefined(cb)) {
            cb = dontPersist;
        }
        if (!_.isBoolean(dontPersist)) {
            dontPersist = false;
        }

        async.waterfall([
            (callback)=> {
                //find item in database
                db.getItem(id, (err, pack)=> {
                    if (!err) {
                        callback(null, pack);
                    } else {
                        callback(true);
                    }
                });
            }, (pack, callback)=> {
                if (!_.isNull(pack) && networks.has(pack.network)) {
                    let nw = networks.get(pack.network);
                    if (_.isUndefined(nw.xdcc[pack.bot])) {
                        nw.xdcc[pack.bot] = [];
                    }
                    let xdcc = nw.xdcc[pack.bot]
                        , i = _.findIndex(xdcc, (p)=> {
                            return p.id == pack.id;
                        });
                    if (i != -1) return callback(true); //exit if already in list
                    pack.xdcc = new Axdcc(nw.irc.client, {
                        pack: pack.id,
                        nick: pack.bot,
                        ssl: sc.settings.get("xdcc:useSSL"),
                        unencryptedFallback: !sc.settings.get("xdcc:forceSSL"),
                        path: sc.settings.get("basic:dlPath"),
                        progressThreshold: sc.settings.get("xdcc:progressThreshold"),
                        resume: sc.settings.get("xdcc:resume")
                    });
                    xdcc.push(pack);
                    if (xdcc.length == 1) {
                        pack.xdcc.emit("start"); //its the first in queue, start it.
                    }
                    pack.xdcc.on("connect", handle.xdccConnect.bind(this, pack));
                    pack.xdcc.on("progress", handle.xdccProgress.bind(this, pack));
                    pack.xdcc.on("complete", handle.xdccComplete.bind(this, pack));
                    pack.xdcc.on("message", handle.xdccMessage.bind(this, pack));
                    pack.xdcc.on("dlerror", handle.xdccError.bind(this, pack));

                    if (!dontPersist) {
                        const settingsArr = sc.dl.get(`${pack.network}:${pack.bot}`) || [];
                        settingsArr.push({
                            pack: pack.id,
                            name: pack.name
                        });
                        sc.dl.set(`${pack.network}:${pack.bot}`, settingsArr);
                        sc.dl.save();
                    }
                    if(_.isFunction(cb))
                        cb(null, pack);
                } else {
                    callback("Pack not found");
                }
            }

        ], cb);
    }


    /**
     * Cancels a download or removes it from queue
     * @param {string} network - name of the network
     * @param {string} bot - name of the bot
     * @param {string} id - number of the packet
     * @param {function} [cb] - optional callback (error, info)
     * @public
     */
    cancelDownload(network, bot, id, cb) {
        if (networks.has(network)) {
            let nw = networks.get(network);
            if (!_.isArray(nw.xdcc[bot]) || nw.xdcc[bot].length == 0) {
                return cb("No download pending from bot"); //dont exists in list
            }

            let xdccs = nw.xdcc[bot]
                , i = _.findIndex(xdccs, p=> {
                    return p.id == id;
                });

            if (i == -1) return cb("Pack not found"); //dont exists in list

            const cnXdcc = xdccs[i].xdcc;

            if (cnXdcc.pack.status != "created") {
                cnXdcc.emit("cancel");
            } else {
                cnXdcc.emit("kill");
            }

            _.remove(nw.xdcc[bot], p=> {
                return p.id == id;
            });

            cb(null, cnXdcc);

        } else {
            cb("Network not found");
        }
    }


    /**
     * generates a plain object from this instance
     * @returns {Object}
     * @public
     */
    toJSON() {
        const nw = _.zipObject(Array.from(networks)),
            fin = Array.from(finished);
        return {
            networks: nw,
            finished: fin
        };
    }

    /**
     * Restores saved state from config
     * @private
     */
    boot() {
        let jNetwork = sc.nw.get() || {},
            jDownloads = sc.dl.get() || {};
        for (var key in jNetwork) {
            let nw = jNetwork[key];
            let logger = new SlingLogger(key);
            nw.opts.onPackinfo = (packData, channel, nick) => {
                let id = packData.id,
                    fileName = packData.fileName;
                delete packData.id;
                delete packData.fileName;
                logger.addPack(id, nick, fileName, packData);
            };
            let irc = SlingIrc.fromJSON(nw);
            networks.set(key, {irc: irc, logger: logger, xdcc: {}});

            if (_.isObject(jDownloads[key])) {
                for (var bot in jDownloads[key]) {
                    if (_.isArray(jDownloads[key][bot]) && jDownloads[key][bot].length) {
                        for (let dl of jDownloads[key][bot]) {
                            this.addDownload(`${key}:${bot}:${dl.pack}`, true);
                        }
                    }
                }
            }
        }
    }

}
module.exports = SlingManager;
