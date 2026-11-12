/* SPDX-License-Identifier: MIT */
// Uses the built-in WebSocket Client. The saved latch contains no credentials.
var savedCommand = script.addStringParameter("Command state", "Saved cue outcome", "None");
var armed = false;
var changingTransport = false;
var sawDisconnect = false;
var settingsChanged = false;
var sessionAddress = "";
var sessionVariable = "";
var sessionPath = "";
var incoming = [];
var incomingChars = 0;
var incomingFault = "";
var connected = false;
var connectingAt = -1;
var verified = false;
var faulted = false;
var unknownWrite = false;
var pending = null;
var nextId = 0;
var nextSendAt = 0;
var statusAt = -1;
var understoodMode = false;
var needStatus = false;
var needMedia = false;
var mediaFiles = [];
var mediaAt = -1;
var REQUEST_TIMEOUT = 1.8;
var CALLBACK_WATCHDOG = 3;
var clockTime = -1;

function now() { return clockTime; }
function checkClock() {
    var time = util.getTime();
    if (!numeric(time) || time < 0 || time < clockTime) {
        fail("Clock changed; connection stopped");
        return false;
    }
    clockTime = time;
    return true;
}
function value(name, data) {
    if (name === "lastCommand") savedCommand.set(data);
    local.values[name].set(data);
}
function isArray(data) { return data !== null && typeof data === "object" && JSON.stringify(data).charAt(0) === "["; }
function object(data) { return data !== null && typeof data === "object" && !isArray(data); }
function numeric(data) {
    if (typeof data !== "number") return false;
    var encoded = JSON.stringify(data);
    return encoded !== "null" && encoded !== "true" && encoded !== "false";
}
function sameNumber(a, b) { return numeric(a) && numeric(b) && a == b; }
// JUCE native booleans can report typeof number; JSON preserves the distinction.
function isTrue(data) { return JSON.stringify(data) === "true"; }
function isFalse(data) { return JSON.stringify(data) === "false"; }
function isBoolean(data) { return isTrue(data) || isFalse(data); }
function integer(data) { return numeric(data) && sameNumber(Math.floor(data), data); }
function enabled() { return isTrue(local.enabled.get()); }
function ready() { return enabled() && connected && verified && !faulted && !unknownWrite && understoodMode && mediaAt >= 0 && pending === null && now() >= nextSendAt && statusAt >= 0 && now() - statusAt <= 5; }
function rejectCommand(message) {
    if (!faulted && !unknownWrite) value("connection", message);
    return false;
}
function closeConnection() {
    armed = false;
    connected = false;
    connectingAt = -1;
    changingTransport = true;
    local.enabled.set(false);
    local.parameters.serverPath.set("");
    changingTransport = false;
    sessionPath = "";
    incoming = [];
    incomingChars = 0;
    incomingFault = "";
}
function fail(message) {
    if (pending !== null && pending.write) {
        unknownWrite = true;
        value("lastCommand", "Unknown: " + message);
    }
    pending = null;
    verified = false;
    faulted = true;
    needStatus = false;
    needMedia = false;
    statusAt = -1;
    value("statusAge", -1);
    value("ready", false);
    value("connection", unknownWrite ? "Outcome unknown; reconcile device" : message);
    closeConnection();
}
function init() {
    var previous = savedCommand.get();
    savedCommand.loadJSONData({value: previous, hideInEditor: true});
    changingTransport = true;
    local.parameters.serverPath.setAttribute("readOnly", true);
    local.parameters.serverPath.set("");
    local.parameters.useSecureConnection.set(false);
    changingTransport = false;
    if ((pending !== null && pending.write) || unknownWrite || (typeof previous === "string" && (previous.indexOf("Pending:") == 0 || previous.indexOf("Unknown:") == 0))) {
        unknownWrite = true;
        value("lastCommand", "Unknown: previous request needs reconciliation");
        fail("Module reinitialised");
        return;
    }
    armed = false;
    connected = false;
    connectingAt = -1;
    sawDisconnect = false;
    settingsChanged = false;
    incoming = [];
    incomingChars = 0;
    incomingFault = "";
    pending = null;
    verified = false;
    faulted = false;
    needStatus = false;
    needMedia = false;
    statusAt = -1;
    mediaAt = -1;
    mediaFiles = [];
    value("ready", false);
    value("connection", "Not connected");
    value("lastCommand", "None");
    value("mode", "Unknown");
    value("playbackOperation", "Unknown");
    value("media", "");
    value("mediaType", "");
    value("paused", false);
    value("pauseKnown", false);
    value("controllerError", "");
    value("playlistItem", -1);
    value("statusAge", -1);
    value("availableMedia", "");
    script.setUpdateRate(20);
}
function validAddress(address) {
    if (typeof address !== "string") return false;
    var parts = address.split(".");
    if (parts.length != 4) return false;
    for (var i = 0; i < 4; i++) {
        if (parts[i].length < 1 || parts[i].length > 3 || (parts[i].length > 1 && parts[i].charAt(0) === "0")) return false;
        var octet = 0;
        for (var j = 0; j < parts[i].length; j++) {
            var digit = "0123456789".indexOf(parts[i].charAt(j));
            if (digit < 0) return false;
            octet = octet * 10 + digit;
        }
        if (octet > 255) return false;
    }
    var first = parseInt(parts[0]);
    return first > 0 && first < 224;
}
function validVariable(variable) {
    if (typeof variable !== "string" || variable.length < 1 || variable.length > 64 || "ABCDEFGHIJKLMNOPQRSTUVWXYZ".indexOf(variable.charAt(0)) < 0) return false;
    for (var i = 1; i < variable.length; i++) if ("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_".indexOf(variable.charAt(i)) < 0) return false;
    return true;
}
function uniqueDevice(address) {
    if (typeof root === "undefined" || root.modules === undefined || typeof root.modules.getItems !== "function") return false;
    var modules = root.modules.getItems();
    if (modules === null || typeof modules !== "object" || !integer(modules.length) || modules.length > 1024) return false;
    for (var i = 0; i < modules.length; i++) {
        var item = modules[i];
        if (item !== local && item.parameters !== undefined && item.parameters.deviceAddress !== undefined && item.parameters.deviceAddress.get() === address) return false;
    }
    return true;
}
function passwordHash(password) {
    var hex = util.encodeSHA256(password);
    if (typeof hex !== "string" || hex.length != 64) return "";
    hex = hex.toLowerCase();
    var bytes = [];
    for (var i = 0; i < 64; i += 2) {
        var high = "0123456789abcdef".indexOf(hex.charAt(i)), low = "0123456789abcdef".indexOf(hex.charAt(i + 1));
        if (high < 0 || low < 0) return "";
        bytes.push(high * 16 + low);
    }
    return util.toBase64(bytes).split("+").join("-").split("/").join("_").split("=").join("");
}
function verifyConnection() {
    if (unknownWrite) return rejectCommand("Outcome unknown; reconcile device");
    if (!enabled()) return rejectCommand("Module disabled");
    if (!checkClock()) return false;
    if (pending !== null || connectingAt >= 0 || now() < nextSendAt) return rejectCommand("Busy");
    if (typeof local.send !== "function") return rejectCommand("WebSocket Client required");
    var address = local.parameters.deviceAddress.get();
    var variable = local.parameters.operatorPasswordVariable.get();
    if (!validAddress(address) || !validVariable(variable)) return rejectCommand("Check address and password variable");
    if (!uniqueDevice(address)) return rejectCommand("Use one module per device");
    var password = util.getEnvironmentVariable(variable);
    if (typeof password !== "string") return rejectCommand("Invalid password variable");
    var hash = passwordHash(password);
    password = "";
    if (hash === "") return rejectCommand("Authentication helper failed");
    changingTransport = true;
    local.enabled.set(false);
    local.parameters.serverPath.setAttribute("readOnly", true);
    local.parameters.useSecureConnection.set(false);
    connected = false;
    verified = false;
    faulted = false;
    statusAt = -1;
    mediaAt = -1;
    mediaFiles = [];
    needStatus = false;
    needMedia = false;
    value("ready", false);
    value("availableMedia", "");
    sessionAddress = address;
    sessionVariable = variable;
    sessionPath = address + ":80/v1.9?user=oper&auth=" + hash;
    local.parameters.serverPath.set(sessionPath);
    hash = "";
    incoming = [];
    incomingChars = 0;
    incomingFault = "";
    sawDisconnect = false;
    settingsChanged = false;
    armed = true;
    connectingAt = now();
    local.enabled.set(true);
    changingTransport = false;
    value("connection", "Connecting");
    return true;
}
function send(req, params, write) {
    if (!enabled() || faulted || unknownWrite || !connected) return rejectCommand("Not connected");
    if (!checkClock()) return false;
    if (!sessionMatches()) { fail("Connection changed"); return false; }
    if (pending !== null || now() < nextSendAt) return rejectCommand("Busy");
    if (write && !ready()) return rejectCommand("Waiting for fresh status");
    if (nextId >= 4294967295) { fail("Request identifiers exhausted"); return false; }
    nextId++;
    pending = {req: req, id: nextId, write: write, started: now()};
    // req must be the first member. Acceptance by the host is not an API ACK.
    var payload = req === "version" ? {req: req, id: nextId} : {req: req, id: nextId, params: params};
    // local.send returns void. Record the attempt before calling it; only an API ACK confirms it.
    if (write) value("lastCommand", "Pending: " + req);
    local.send(JSON.stringify(payload));
    value("ready", false);
    return true;
}
function sessionMatches() {
    return armed && !sawDisconnect && !settingsChanged &&
        local.parameters.deviceAddress.get() === sessionAddress &&
        local.parameters.operatorPasswordVariable.get() === sessionVariable &&
        local.parameters.serverPath.get() === sessionPath &&
        isFalse(local.parameters.useSecureConnection.get()) &&
        isTrue(local.parameters.serverPath.getAttribute("readOnly")) &&
        isTrue(local.parameters.connected.get());
}
function validError(data) { return object(data) && integer(data.code) && typeof data.msg === "string"; }
function describeError(data) { return data.code + ": " + data.msg; }
function compatible(version) {
    if (!object(version) || !sameNumber(version.prodFamily, 1349089331) || ["PixLite A4-S Mk3", "PixLite E16-S Mk3"].indexOf(version.prodName) < 0 || !object(version.operUser) || !isTrue(version.operUser.en) || !isBoolean(version.operUser.authReqd) || !isArray(version.apiVer)) return false;
    for (var i = 0; i < version.apiVer.length; i++) {
        var api = version.apiVer[i];
        if (object(api) && api.maj === "v1" && isArray(api.min) && api.min.length == 2 && integer(api.min[0]) && integer(api.min[1]) && api.min[0] >= 0 && api.min[0] <= 9 && api.min[1] >= 9) return true;
    }
    return false;
}
function validStatus(status) {
    if (!object(status) || typeof status.mode !== "string" || status.mode.length == 0 || (status.params !== undefined && !object(status.params)) || (status.state !== undefined && !object(status.state))) return false;
    var params = object(status.params) ? status.params : {};
    var state = object(status.state) ? status.state : {};
    return (params.op === undefined || typeof params.op === "string") && (params.file === undefined || typeof params.file === "string") && (state.paus === undefined || isBoolean(state.paus)) && (state.item === undefined || integer(state.item)) && (state.err === undefined || validError(state.err));
}
function acceptStatus(status) {
    if (!validStatus(status)) return false;
    var params = object(status.params) ? status.params : {};
    var state = object(status.state) ? status.state : {};
    understoodMode = ["live", "playback", "record", "testData"].indexOf(status.mode) >= 0;
    statusAt = now();
    value("mode", status.mode);
    value("playbackOperation", status.mode === "playback" && typeof params.op === "string" ? params.op : "Not applicable");
    value("media", typeof params.file === "string" ? mediaName(params.file) : "");
    value("mediaType", typeof params.file === "string" ? mediaType(params.file) : "");
    value("paused", isTrue(state.paus));
    value("pauseKnown", isBoolean(state.paus));
    value("playlistItem", integer(state.item) ? state.item : -1);
    value("controllerError", state.err === undefined ? "" : describeError(state.err));
    value("statusAge", 0);
    value("connection", understoodMode ? "Connected" : "Unknown mode; cues blocked");
    return true;
}
function acceptMedia(result) {
    if (!object(result) || !isArray(result.files) || result.files.length > 4096) return false;
    var files = [], scenes = [], playlists = [];
    for (var i = 0; i < result.files.length; i++) {
        var entry = result.files[i];
        if (object(entry) && typeof entry.attr === "string" && entry.attr.charAt(0) === "v" && mediaType(entry.file) !== "") {
            files.push(entry.file);
            if (mediaType(entry.file) === "Scene") scenes.push(mediaName(entry.file));
            else playlists.push(mediaName(entry.file));
        }
    }
    mediaFiles = files;
    mediaAt = now();
    var groups = [];
    if (scenes.length) groups.push("Scenes:\n" + scenes.join("\n"));
    if (playlists.length) groups.push("Playlists:\n" + playlists.join("\n"));
    value("availableMedia", groups.join("\n\n"));
    return true;
}
function wsMessageReceived(text) {
    if (!armed || changingTransport || faulted || !enabled()) return;
    if (typeof text !== "string" || text.length + incomingChars > 1048576 || incoming.length >= 32) {
        incomingFault = "Invalid or excessive responses";
        return;
    }
    incoming.push(text);
    incomingChars += text.length;
}
function processMessage(text) {
    if (!armed || !connected || faulted) return;
    if (!enabled()) { fail("Module disabled"); return; }
    if (!checkClock()) return;
    if (typeof text !== "string" || text.length > 1048576) { fail("Invalid response size"); return; }
    if (!boundedJSON(text)) { fail("Invalid JSON depth"); return; }
    var data;
    data = JSON.parse(text);
    if (!object(data)) { fail("Invalid response"); return; }
    if (data.notify !== undefined) {
        if (typeof data.notify !== "string" || data.resp !== undefined || data.id !== undefined || data.err !== undefined) { fail("Invalid notification"); return; }
        if (data.notify === "disconnect") { fail("Controller disconnected"); return; }
        if (!verified) return;
        if (data.notify === "statusChange" && (!object(data.params) || !acceptStatus(data.params.status))) { fail("Invalid status notification"); return; }
        if (data.notify === "fileChange") { mediaAt = -1; mediaFiles = []; needMedia = true; value("availableMedia", ""); }
        value("ready", ready());
        return;
    }
    if (pending === null) return;
    var current = pending;
    if (now() - current.started >= CALLBACK_WATCHDOG) { fail("Callback watchdog elapsed"); return; }
    if (now() - current.started >= REQUEST_TIMEOUT || !sameNumber(data.id, current.id) || data.resp !== current.req) { fail("Late or mismatched response"); return; }
    if (data.err !== undefined) {
        if (!validError(data.err) || data.result !== undefined) { fail("Invalid API error"); return; }
        pending = null;
        if (current.write) {
            value("lastCommand", "Rejected: " + describeError(data.err));
            statusAt = -1;
            needStatus = true;
        } else { fail("API read rejected"); return; }
    } else {
        if (current.req === "version") {
            if (!compatible(data.result)) { fail("Unsupported device or API"); return; }
            verified = true;
            needStatus = true;
            needMedia = true;
        } else if (current.req === "statusRead") {
            if (!object(data.result) || !acceptStatus(data.result.status)) { fail("Invalid status"); return; }
        } else if (current.req === "fileList") {
            if (!acceptMedia(data.result)) { fail("Invalid media list"); return; }
        } else if (current.write) {
            if ((current.req === "modeLive" || current.req === "modePlayback") && (!object(data.result) || !validStatus(data.result.status))) { fail("Invalid mode response"); return; }
            value("lastCommand", "Acknowledged: " + current.req);
            statusAt = -1;
            needStatus = true;
        }
        pending = null;
    }
    nextSendAt = now() + 0.15;
    value("ready", ready());
}
function boundedJSON(text) {
    var depth = 0, quoted = false, escaped = false;
    for (var i = 0; i < text.length; i++) {
        var c = text.charAt(i);
        if (quoted) {
            if (escaped) escaped = false;
            else if (c === "\\") escaped = true;
            else if (c === "\"") quoted = false;
        } else if (c === "\"") quoted = true;
        else if (c === "{" || c === "[") { depth++; if (depth > 32) return false; }
        else if (c === "}" || c === "]") { depth--; if (depth < 0) return false; }
    }
    return depth === 0 && !quoted;
}
function validFilename(file, extension) {
    if (typeof file !== "string" || file.length <= extension.length || file.length > 63 || file.substring(file.length - extension.length, file.length) !== extension) return false;
    for (var i = 0; i < file.length; i++) {
        var code = file.charCodeAt(i);
        if (code < 32 || code > 126 || '\\/:*?"<>|'.indexOf(file.charAt(i)) >= 0) return false;
    }
    return true;
}
function mediaType(file) { return validFilename(file, ".scn") ? "Scene" : validFilename(file, ".pl") ? "Playlist" : ""; }
function mediaName(file) { return mediaType(file) === "Scene" ? file.substring(0, file.length - 4) : mediaType(file) === "Playlist" ? file.substring(0, file.length - 3) : file; }
function validFade(fade) { return integer(fade) && fade >= 0 && fade <= 60000; }
function playFile(file, extension, fade) {
    if (!checkClock()) return false;
    if (typeof file !== "string" || !validFade(fade)) return rejectCommand("Invalid filename or fade");
    var full = validFilename(file, extension), named = "";
    for (var i = 0; i < mediaFiles.length; i++) if (validFilename(mediaFiles[i], extension) && mediaName(mediaFiles[i]) === file) named = mediaFiles[i];
    if (full && named !== "" && named !== file) return rejectCommand("Ambiguous media name");
    if (!full) {
        if (mediaAt < 0 || now() - mediaAt > 5) { needMedia = true; return rejectCommand("Refreshing media; select again"); }
        if (named === "") return rejectCommand("Media not listed");
        file = named;
    }
    return send("modePlayback", {op: "File", file: file, cnt: 0, fadeMs: fade}, true);
}
function playScene(file, fade) { return playFile(file, ".scn", fade); }
function playPlaylist(file, fade) { return playFile(file, ".pl", fade); }
function playback(op, fade) {
    if (!validFade(fade)) return rejectCommand("Invalid fade");
    if (local.values.mode.get() !== "playback") return rejectCommand("Nothing is playing");
    if (op === "Nxt" && (local.values.playbackOperation.get() !== "File" || local.values.mediaType.get() !== "Playlist" || local.values.playlistItem.get() < 0)) return rejectCommand("No current playlist item");
    return send("playbackCtrl", {op: op, fadeMs: fade}, true);
}
function pausePlayback(fade) { return playback("Paus", fade); }
function resumePlayback(fade) { return playback("Play", fade); }
function nextPlaylistItem(fade) { return playback("Nxt", fade); }
function selectLive(fade) { return validFade(fade) ? send("modeLive", {fadeMs: fade}, true) : rejectCommand("Invalid fade"); }
function outputMode(op, fade) { return validFade(fade) ? send("modePlayback", {op: op, durMs: 0, fadeMs: fade}, true) : rejectCommand("Invalid fade"); }
function selectBlank(fade) { return outputMode("Blank", fade); }
function selectFreeze(fade) { return outputMode("Freeze", fade); }
function refreshStatus() { if (!verified) return rejectCommand("Verify connection first"); needStatus = true; return true; }
function refreshMedia() { if (!verified) return rejectCommand("Verify connection first"); needMedia = true; return true; }
function moduleParameterChanged(param) {
    if (changingTransport || !armed) return;
    if (param.is(local.parameters.connected) && !isTrue(local.parameters.connected.get())) sawDisconnect = true;
    if (param.is(local.parameters.deviceAddress) || param.is(local.parameters.operatorPasswordVariable) ||
        param.is(local.parameters.serverPath) || param.is(local.parameters.useSecureConnection)) settingsChanged = true;
}
function update(deltaTime) {
    if (!enabled()) { if (armed || pending !== null) fail("Module disabled"); return; }
    if (!checkClock()) return;
    if (armed && (sawDisconnect || settingsChanged ||
        local.parameters.deviceAddress.get() !== sessionAddress ||
        local.parameters.operatorPasswordVariable.get() !== sessionVariable)) { fail("Connection changed or lost"); return; }
    if (incomingFault !== "") { fail(incomingFault); return; }
    if (pending !== null && now() - pending.started >= CALLBACK_WATCHDOG) { fail("Callback watchdog elapsed"); return; }
    if (connectingAt >= 0 && now() - connectingAt >= REQUEST_TIMEOUT) { fail("Connection timed out"); return; }
    if (pending !== null && now() - pending.started >= REQUEST_TIMEOUT) { fail("Request timed out"); return; }
    if (armed && !connected && isTrue(local.parameters.connected.get())) {
        connected = true;
        connectingAt = -1;
        send("version", {}, false);
    }
    var messages = incoming;
    incoming = [];
    incomingChars = 0;
    for (var i = 0; i < messages.length; i++) {
        processMessage(messages[i]);
        if (!armed || faulted) return;
    }
    value("statusAge", statusAt < 0 ? -1 : Math.max(0, now() - statusAt));
    value("ready", ready());
    if (!connected || !verified || faulted || pending !== null || now() < nextSendAt) return;
    if (needStatus || statusAt < 0 || now() - statusAt >= 2) { needStatus = false; send("statusRead", {path: [""]}, false); }
    else if (needMedia) { needMedia = false; send("fileList", {pattern: ["*.scn", "*.pl"]}, false); }
}
