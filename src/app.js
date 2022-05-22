const { exit } = require('process');

require('dotenv').config();
var steam = require("steam"),
    util = require("util"),
    fs = require("fs"),
    crypto = require("crypto"),
    dota2 = require("dota2"),
    long = require("long"),
    steamID = require("@node-steam/id"),
    heroNames = require('./heroNames.js'),
    tmi = require('tmi.js'),
    { Sequelize } = require('sequelize'),
    steamClient = new steam.SteamClient(),
    steamUser = new steam.SteamUser(steamClient),
    steamFriends = new steam.SteamFriends(steamClient),
    Dota2 = new dota2.Dota2Client(steamClient, false);

const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const sequelize = new Sequelize('postgres', 'postgres', process.env.POSTGRES_PASSWORD, {
  host: 'db',
  dialect: 'postgres'
});


// testa!
(async () => {
    try {
        await sequelize.authenticate();
        console.log('Connection has been established successfully.');
      } catch (error) {
        console.error('Unable to connect to the database:', error);
      }
})();

const clientId = process.env.CLIENT_ID;

// Load in server list if we've saved one before
if (fs.existsSync('servers')) {
    steam.servers = JSON.parse(fs.readFileSync('servers'));
}

const generateRP = (txt) => {
    const temp = {};
    // eslint-disable-next-line no-control-regex
    txt.replace(/(?:^\x00([^\x00]*)\x00(.*)\x08$|\x01([^\x00]*)\x00([^\x00]*)\x00)/gm, (_match, ...args) => {
        if (args[0]) {
            temp[args[0]] = generateRP(args[1]);
        } else if (args[2]) {
            [, , , temp[args[2]]] = args;
        }
        return '';
    });
    return temp;
};

const emptyStringArray = [];
const generateObject = (txt) => {
    const temp = {};
    txt.replace(/(?:(\w+): (\w+|"[^"]*"))|(?:(\w+) { ([^}]*) })/g, (_match, ...args) => {
        if (args[0]) {
            if (temp[args[0]]) {
                temp[args[0]] = emptyStringArray.concat(temp[args[0]], [args[1].trim('"')]);
            } else {
                temp[args[0]] = args[1].trim('"');
            }
        } else if (args[2]) {
            if (temp[args[2]]) {
                temp[args[2]] = emptyStringArray.concat(temp[args[2]], [generateObject(args[3])]);
            } else {
                temp[args[2]] = generateObject(args[3]);
            }
        }
        return '';
    });
    return temp;
};

let lobbyIDs = new Set();
let observedMatches = new Set();
let matchAggregate = new Set();
let channels = new Map();

channels.set('bizarelli', {
    accountIDs32: [1026549199, 917427034],
    currentMatches: new Set(),
    broadcasterID: "172248525",
    token: "yyqq20t0f2q02ebs9mrq0bya816m64",
    refreshToken: "d1aqzw8evvvibb289y4s6opybb4ia1bl36zdgb49jkcek8yox5"
})

function getMatchID(match) {
    return new long(match.match_id.getLowBits(), match.match_id.getHighBits()).toString();
}


const client = new tmi.Client({
    options: { debug: false },
    identity: {
        username: 'nerifbot',
        password: 'oauth:ichz0x4y9ldjesd8ci1jtqmp1k99qf'
    },
    channels: Array.from(channels.keys())
});

client.connect();

client.on("connected", (addr, port) => {
    console.log("Conectado à Twitch");
});

client.on('chat', (channel, user, message, self) => {
    // Ignore echoed messages.
    if (self) return;
});

/* Steam logic */
var onSteamLogOn = function onSteamLogOn(logonResp) {
    if (logonResp.eresult == steam.EResult.OK) {
        steamFriends.setPersonaState(steam.EPersonaState.Busy); // to display your steamClient's status as "Online"
        steamFriends.setPersonaName(process.env.STEAM_NAME); // to change its nickname
        var steamRichPresence = new steam.SteamRichPresence(steamClient, 570);
        setInterval(() => {
            channels.forEach((ch, channelName) => {
                steamRichPresence.request(ch.accountIDs32.map(id32 => steamID.fromAccountID(id32).getSteamID64()));
            })
        }, 5000);
        steamRichPresence.on('info', async (data) => {
            for (let i = 0; i < data.rich_presence.length; i += 1) {
                const temp = data.rich_presence[i].rich_presence_kv?.toString();
                const obj = generateRP(temp);
                const rp = obj.RP;
                // console.log(rp);
                if (rp?.WatchableGameID) lobbyIDs.add(rp.WatchableGameID);
            }
        });
        util.log("Logged on.");
        Dota2.launch();
        Dota2.on("ready", function () {
            console.log("Node-dota2 ready.");
            //TODO: fazer suportar mais que 100 partidas assistidas de uma vez
            setInterval(() => {
                Dota2.requestSourceTVGames({
                    start_game: 90,
                    lobby_ids: Array.from(lobbyIDs)
                });
            }, 15 * 1000);
        });
        let pageCount = 0;
        let matchToLobby = new Map();
        Dota2.on("sourceTVGamesData", function (data) {
            // console.log("Receiving source TV data. Page: " + data.start_game);
            pageCount += data.start_game;
            let playerIDs = new Set();
            channels.forEach((ch, channelName) => {
                ch.accountIDs32.forEach(id => playerIDs.add(id));
            });
            data.game_list.forEach(match => {
                const matchID = getMatchID(match);
                matchToLobby.set(matchID, new long(match.lobby_id.getLowBits(), match.lobby_id.getHighBits()).toString());
                const players = match.players.map(player => player.account_id);
                if (players.some(playerID => playerIDs.has(playerID))) {
                    matchAggregate.add(matchID);
                    if (observedMatches.has(matchID)) {
                        console.log("Continued observing match " + matchID);
                    }
                    else {
                        channels.forEach((ch, index) => {
                            if (players.some(playerID => ch.accountIDs32.includes(playerID))) {
                                ch.currentMatches.add(matchID);
                            }
                        });
                        observedMatches.add(matchID);
                        console.log("Started observing match " + matchID);
                        channels.forEach((ch, channelName) => {
                            if (ch.currentMatches.has(matchID)) {
                                (async () => {
                                    const res = await fetch('https://api.twitch.tv/helix/predictions', {
                                        method: 'post',
                                        body: JSON.stringify({
                                            "broadcaster_id": ch.broadcasterID,
                                            "title": channelName + " irá ganhar essa partida?",
                                            "outcomes": [
                                                {
                                                    "title": "Sim"
                                                },
                                                {
                                                    "title": "Não"
                                                }
                                            ],
                                            "prediction_window": 5 * 60
                                        }),
                                        headers: {
                                            'Client-Id': clientId,
                                            'Content-Type': 'application/json',
                                            'Authorization': 'Bearer ' + ch.token,
                                        }
                                    });
                                    console.log(res.status);
                                    if (res.status == 200) {
                                        client.say(channelName, "/announce Aberta predição para partida.");
                                    }
                                })();
                            }
                        });
                        // client.say("bizarelli", "/announce Aberta predição para partida.");
                    }
                }
            });
            // console.log(matchAggregate);
            if (pageCount == 450) {
                observedMatches.forEach(matchID => {
                    if (!matchAggregate.has(matchID)) {
                        // client.say("bizarelli", "/announce Finalizada predição para partida");
                        lobbyIDs.delete(matchToLobby.get(matchID));
                        Dota2.requestMatchDetails(matchID, function (err, data) {
                            const radiantWin = data.match.match_outcome == 2;
                            console.log("Finished prediction for match " + matchID);
                            channels.forEach((ch, channelName) => {
                                if (ch.currentMatches.has(matchID)) {
                                    const slot = data.match.players.find(p => ch.accountIDs32.includes(p.account_id)).player_slot;
                                    (async () => {
                                        let res = await fetch('https://api.twitch.tv/helix/predictions?broadcaster_id=' + ch.broadcasterID, {
                                            method: 'get',
                                            headers: {
                                                'Client-Id': clientId,
                                                'Content-Type': 'application/json',
                                                'Authorization': 'Bearer ' + ch.token,
                                            }
                                        });
                                        const data = await res.json();
                                        const predictionID = data.data[0].id;
                                        let outcomeID;
                                        if (slot <= 4 && radiantWin || slot >= 5 && !radiantWin) {
                                            outcomeID = data.data[0].outcomes[0].id; // win
                                        }
                                        else {
                                            outcomeID = data.data[0].outcomes[1].id; // loss
                                        }
                                        res = await fetch('https://api.twitch.tv/helix/predictions', {
                                            method: 'patch',
                                            body: JSON.stringify({
                                                "broadcaster_id": ch.broadcasterID,
                                                "id": predictionID,
                                                "status": "RESOLVED",
                                                "winning_outcome_id": outcomeID
                                            }),
                                            headers: {
                                                'Client-Id': clientId,
                                                'Content-Type': 'application/json',
                                                'Authorization': 'Bearer ' + ch.token,
                                            }
                                        });
                                        if (res.status == 200) {
                                            client.say(channelName, "/announce Finalizada predição para partida. " + (radiantWin ? "Vitória do Radiant." : "Vitória do Dire."));
                                        }
                                    })();
                                    ch.currentMatches.delete(matchID);
                                } 
                            });
                        });
                        observedMatches.delete(matchID);
                    }
                });
                pageCount = 0;
                matchAggregate.clear();
                matchToLobby.clear();
            }

            // console.log(data.game_list.map(match => new long(match.match_id.getLowBits(), match.match_id.getHighBits()).toString()));
            // data.game_list.filter(e => e.players.map(p => p.account_id).includes(accountID32)).forEach(e => {
            //     console.log("================= MATCH ======================");
            //     console.log(e.players.map(p => p.account_id).filter(i => i == accountID32));
            //     player_list = {};
            //     e.players.forEach(p => player_list[p.account_id] = heroNames.heroes[p.hero_id]);
            //     console.log(player_list);
            //     console.log("Lobby ID: " + new long(e.lobby_id.getLowBits(), e.lobby_id.getHighBits()).toString());
            //     console.log("Server steam ID: " + new long(e.server_steam_id.getLowBits(), e.server_steam_id.getHighBits()).toString());
            //     console.log("match ID: " + new long(e.match_id.getLowBits(), e.match_id.getHighBits()).toString());
            // });
        });
        Dota2.on("unready", function onUnready() {
            console.log("Node-dota2 unready.");
        });
        Dota2.on("unhandled", function (kMsg) {
            util.log("UNHANDLED MESSAGE " + dota2._getMessageName(kMsg));
        });
    };
},
    onSteamServers = function onSteamServers(servers) {
        util.log("Received servers.");
        fs.writeFile('servers', JSON.stringify(servers), (err) => {
            if (err) { if (this.debug) util.log("Error writing "); }
            else { if (this.debug) util.log(""); }
        });
    },
    onSteamLogOff = function onSteamLogOff(eresult) {
        util.log("Logged off from Steam.");
    },
    onSteamError = function onSteamError(error) {
        util.log("Connection closed by server: " + error);
    };

steamUser.on('updateMachineAuth', function (sentry, callback) {
    console.log('creating sentry file');
    var hashedSentry = crypto.createHash('sha1').update(sentry.bytes).digest();
    fs.writeFileSync('sentry', hashedSentry)
    util.log("sentryfile saved");
    callback({
        sha_file: hashedSentry
    });
});

// Login, only passing authCode if it exists
var logOnDetails = {
    "account_name": process.env.STEAM_USER,
    "password": process.env.STEAM_PASS,
};
if (process.env.STEAM_GUARD_CODE) logOnDetails.auth_code = process.env.STEAM_GUARD_CODE;
if (process.env.TWO_FACTOR_CODE) logOnDetails.two_factor_code = process.env.TWO_FACTOR_CODE;

try {
    var sentry = fs.readFileSync('sentry');
    if (sentry.length) logOnDetails.sha_sentryfile = sentry;
} catch (beef) {
    util.log("Cannot load the sentry. " + beef);
}

steamClient.connect();
steamClient.on('connected', function () {
    steamUser.logOn(logOnDetails);
});
steamClient.on('logOnResponse', onSteamLogOn);
steamClient.on('loggedOff', onSteamLogOff);
steamClient.on('error', onSteamError);
steamClient.on('servers', onSteamServers);
