;(function () {

var logger = {
    log: function (){},
    warn: function (){},
    error: function (){}
};

// normalize environment
var RTCPeerConnection = null,
    getUserMedia = null,
    attachMediaStream = null,
    reattachMediaStream = null,
    browser = null,
    screenSharingSupport = false;
    webRTCSupport = true;

if (navigator.mozGetUserMedia) {
    logger.log("This appears to be Firefox");

    browser = "firefox";

    // The RTCPeerConnection object.
    RTCPeerConnection = mozRTCPeerConnection;

    // The RTCSessionDescription object.
    RTCSessionDescription = mozRTCSessionDescription;

    // The RTCIceCandidate object.
    RTCIceCandidate = mozRTCIceCandidate;

    // Get UserMedia (only difference is the prefix).
    // Code from Adam Barth.
    getUserMedia = navigator.mozGetUserMedia.bind(navigator);

    // Attach a media stream to an element.
    attachMediaStream = function(element, stream) {
        element.mozSrcObject = stream;
        element.play();
    };

    reattachMediaStream = function(to, from) {
        to.mozSrcObject = from.mozSrcObject;
        to.play();
    };

    // Fake get{Video,Audio}Tracks
    MediaStream.prototype.getVideoTracks = function() {
        return [];
    };

    MediaStream.prototype.getAudioTracks = function() {
        return [];
    };
} else if (navigator.webkitGetUserMedia) {
    browser = "chrome";

    screenSharingSupport = navigator.userAgent.match('Chrome') && parseInt(navigator.userAgent.match(/Chrome\/(.*) /)[1]) >= 26

    // The RTCPeerConnection object.
    RTCPeerConnection = webkitRTCPeerConnection;

    // Get UserMedia (only difference is the prefix).
    // Code from Adam Barth.
    getUserMedia = navigator.webkitGetUserMedia.bind(navigator);

    // Attach a media stream to an element.
    attachMediaStream = function(element, stream) {
        element.autoplay = true;
        element.src = webkitURL.createObjectURL(stream);
    };

    reattachMediaStream = function(to, from) {
        to.src = from.src;
    };

    // The representation of tracks in a stream is changed in M26.
    // Unify them for earlier Chrome versions in the coexisting period.
    if (!webkitMediaStream.prototype.getVideoTracks) {
        webkitMediaStream.prototype.getVideoTracks = function() {
            return this.videoTracks;
        };
        webkitMediaStream.prototype.getAudioTracks = function() {
            return this.audioTracks;
        };
    }

    // New syntax of getXXXStreams method in M26.
    if (!webkitRTCPeerConnection.prototype.getLocalStreams) {
        webkitRTCPeerConnection.prototype.getLocalStreams = function() {
            return this.localStreams;
        };
        webkitRTCPeerConnection.prototype.getRemoteStreams = function() {
            return this.remoteStreams;
        };
    }
} else {
    webRTCSupport = false;
    throw new Error("Browser does not appear to be WebRTC-capable");
}


// emitter that we use as a base
function WildEmitter() {
    this.callbacks = {};
}

// Listen on the given `event` with `fn`. Store a group name if present.
WildEmitter.prototype.on = function (event, groupName, fn) {
    var hasGroup = (arguments.length === 3),
        group = hasGroup ? arguments[1] : undefined,
        func = hasGroup ? arguments[2] : arguments[1];
    func._groupName = group;
    (this.callbacks[event] = this.callbacks[event] || []).push(func);
    return this;
};

// Adds an `event` listener that will be invoked a single
// time then automatically removed.
WildEmitter.prototype.once = function (event, fn) {
    var self = this;
    function on() {
        self.off(event, on);
        fn.apply(this, arguments);
    }
    this.on(event, on);
    return this;
};

// Unbinds an entire group
WildEmitter.prototype.releaseGroup = function (groupName) {
    var item, i, len, handlers;
    for (item in this.callbacks) {
        handlers = this.callbacks[item];
        for (i = 0, len = handlers.length; i < len; i++) {
            if (handlers[i]._groupName === groupName) {
                handlers.splice(i, 1);
                i--;
                len--;
            }
        }
    }
    return this;
};

// Remove the given callback for `event` or all
// registered callbacks.
WildEmitter.prototype.off = function (event, fn) {
    var callbacks = this.callbacks[event],
        i;

    if (!callbacks) return this;

    // remove all handlers
    if (arguments.length === 1) {
        delete this.callbacks[event];
        return this;
    }

    // remove specific handler
    i = callbacks.indexOf(fn);
    callbacks.splice(i, 1);
    return this;
};

// Emit `event` with the given args.
// also calls any `*` handlers
WildEmitter.prototype.emit = function (event) {
    var args = [].slice.call(arguments, 1),
        callbacks = this.callbacks[event],
        specialCallbacks = this.getWildcardCallbacks(event),
        i,
        len,
        item;

    if (callbacks) {
        for (i = 0, len = callbacks.length; i < len; ++i) {
            callbacks[i].apply(this, args);
        }
    }

    if (specialCallbacks) {
        for (i = 0, len = specialCallbacks.length; i < len; ++i) {
            specialCallbacks[i].apply(this, [event].concat(args));
        }
    }

    return this;
};

// Helper for for finding special wildcard event handlers that match the event
WildEmitter.prototype.getWildcardCallbacks = function (eventName) {
    var item,
        split,
        result = [];

    for (item in this.callbacks) {
        split = item.split('*');
        if (item === '*' || (split.length === 2 && eventName.slice(0, split[1].length) === split[1])) {
            result = result.concat(this.callbacks[item]);
        }
    }
    return result;
};


function WebRTC(opts) {
    var self = this,
        options = opts || {},
        config = this.config = {
            url: 'http://signaling.simplewebrtc.com:8888',
            log: false,
            localVideoEl: '',
            remoteVideosEl: '',
            autoRequestMedia: false,
            // makes the entire PC config overridable
            peerConnectionConfig: {
                iceServers: browser == 'firefox' ? [{"url":"stun:124.124.124.2"}] : [{"url": "stun:stun.l.google.com:19302"}]
            },
            peerConnectionContraints: {
                optional: [{"DtlsSrtpKeyAgreement": true}]
            },
            media: {
                audio:true,
                video: {
                    mandatory: {},
                    optional: []
                }
            }
        },
        item,
        connection;

    // check for support
    if (!webRTCSupport) {
        console.error('Your browser doesn\'t seem to support WebRTC');
    }

    // expose screensharing check
    this.screenSharingSupport = screenSharingSupport;

    // set options
    for (item in options) {
        this.config[item] = options[item];
    }

    // log if configured to
    if (this.config.log) logger = console;

    // where we'll store our peer connections
    this.peers = [];

    // our socket.io connection
    connection = this.connection = io.connect(this.config.url);

    connection.on('connect', function () {
        self.emit('ready', connection.socket.sessionid);
        self.sessionReady = true;
        self.testReadiness();
    });

    connection.on('message', function (message) {
        var peers = self.getPeers(message.from, message.roomType),
            peer;

        if (message.type === 'offer') {
            peer = self.createPeer({
                id: message.from,
                type: message.roomType,
                sharemyscreen: message.roomType === 'screen' && !message.broadcaster
            });
            peer.handleMessage(message);
        } else if (peers.length) {
            peers.forEach(function (peer) {
                peer.handleMessage(message);
            });
        }
    });

    connection.on('remove', function (room) {
        if (room.id !== self.connection.socket.sessionid) {
            self.removeForPeerSession(room.id, room.type);
        }
    });

    WildEmitter.call(this);

    // log events
    this.on('*', function (event, val1, val2) {
        logger.log('event:', event, val1, val2);
    });

    // auto request if configured
    if (this.config.autoRequestMedia) this.startLocalVideo();
}

WebRTC.prototype = Object.create(WildEmitter.prototype, {
    constructor: {
        value: WebRTC
    }
});

WebRTC.prototype.getEl = function (idOrEl) {
    if (typeof idOrEl == 'string') {
        return document.getElementById(idOrEl);
    } else {
        return idOrEl;
    }
};

// this accepts either element ID or element
// and either the video tag itself or a container
// that will be used to put the video tag into.
WebRTC.prototype.getLocalVideoContainer = function () {
    var el = this.getEl(this.config.localVideoEl);
    if (el && el.tagName === 'VIDEO') {
        return el;
    } else {
        var video = document.createElement('video');
        el.appendChild(video);
        return video;
    }
};

WebRTC.prototype.getRemoteVideoContainer = function () {
    return this.getEl(this.config.remoteVideosEl);
};

WebRTC.prototype.createPeer = function (opts) {
    var peer;
    opts.parent = this;
    peer = new Peer(opts);
    this.peers.push(peer);
    return peer;
};

WebRTC.prototype.createRoom = function (name, cb) {
    if (arguments.length === 2) {
        this.connection.emit('create', name, cb);
    } else {
        this.connection.emit('create', name);
    }
};

WebRTC.prototype.joinRoom = function (name) {
    var self = this;
    this.roomName = name;
    this.connection.emit('join', name, function (roomDescription) {
        var id,
            client,
            type,
            peer;
        for (id in roomDescription) {
            client = roomDescription[id];
            for (type in client) {
                if (client[type]) {
                    peer = self.createPeer({
                        id: id,
                        type: type
                    });
                    peer.start();
                }
            }
        }
    });
};

WebRTC.prototype.leaveRoom = function () {
    if (this.roomName) {
        this.connection.emit('leave', this.roomName);
        this.peers.forEach(function (peer) {
            peer.end();
        });
    }
};

WebRTC.prototype.testReadiness = function () {
    var self = this;
    if (this.localStream && this.sessionReady) {
        // This timeout is a workaround for the strange no-audio bug
        // as described here: https://code.google.com/p/webrtc/issues/detail?id=1525
        // remove timeout when this is fixed.
        setTimeout(function () {
            self.emit('readyToCall', self.connection.socket.sessionid);
        }, 1000);
    }
};

WebRTC.prototype.startLocalVideo = function (element) {
    var self = this;
    getUserMedia(this.config.media, function (stream) {
        attachMediaStream(element || self.getLocalVideoContainer(), stream);
        self.localStream = stream;
        self.testReadiness();
    }, function () {
        throw new Error('Failed to get access to local media.');
    });
};

// Audio controls
WebRTC.prototype.mute = function () {
    this._audioEnabled(false);
    this.emit('audioOff');
};
WebRTC.prototype.unmute = function () {
    this._audioEnabled(true);
    this.emit('audioOn');
};

// Video controls
WebRTC.prototype.pauseVideo = function () {
    this._videoEnabled(false);
    this.emit('videoOff');
};
WebRTC.prototype.resumeVideo = function () {
    this._videoEnabled(true);
    this.emit('videoOn');
};

// Combined controls
WebRTC.prototype.pause = function () {
    this.mute();
    this.pauseVideo();
};
WebRTC.prototype.resume = function () {
    this.unmute();
    this.resumeVideo();
};

// Internal methods for enabling/disabling audio/video
WebRTC.prototype._audioEnabled = function (bool) {
    this.localStream.getAudioTracks().forEach(function (track) {
        track.enabled = !!bool;
    });
};
WebRTC.prototype._videoEnabled = function (bool) {
    this.localStream.getVideoTracks().forEach(function (track) {
        track.enabled = !!bool;
    });
};

WebRTC.prototype.shareScreen = function () {
    var self = this,
        peer;
    if (screenSharingSupport) {
        getUserMedia({
            video: {
                mandatory: {
                    chromeMediaSource: 'screen'
                }
            }
        }, function (stream) {
            var item,
                el = document.createElement('video'),
                container = self.getRemoteVideoContainer();

            self.localScreen = stream;

            el.id = 'localScreen';
            attachMediaStream(el, stream);
            if (container) {
                container.appendChild(el);
            }
            self.emit('videoAdded', el);
            self.connection.emit('shareScreen');
            self.peers.forEach(function (existingPeer) {
                var peer;
                if (existingPeer.type === 'video') {
                    peer = self.createPeer({
                        id: existingPeer.id,
                        type: 'screen',
                        sharemyscreen: true
                    });
                    peer.start();
                }
            });
        }, function () {
            throw new Error('Failed to access to screen media.');
        });
    }
};

WebRTC.prototype.stopScreenShare = function () {
    this.connection.emit('unshareScreen');
    var videoEl = document.getElementById('localScreen'),
        container = this.getRemoteVideoContainer(),
        stream = this.localScreen;

    if (container && videoEl) {
        container.removeChild(videoEl);
    }
    this.localScreen.stop();
    this.peers.forEach(function (peer) {
        if (peer.broadcaster) {
            peer.end();
            // a hack to emit the event the removes the video
            // element that we want
            peer.emit('videoRemoved', videoEl);
        }
    });
    delete this.localScreen;
};

WebRTC.prototype.removeForPeerSession = function (id, type) {
    this.getPeers(id, type).forEach(function (peer) {
        peer.end();
    });
};

// fetches all Peer objects by session id and/or type
WebRTC.prototype.getPeers = function (sessionId, type) {
    return this.peers.filter(function (peer) {
        return (!sessionId || peer.id === sessionId) && (!type || peer.type === type);
    });
};


function Peer(options) {
    var self = this;

    this.id = options.id;
    this.parent = options.parent;
    this.type = options.type || 'video';
    this.oneway = options.oneway || false;
    this.sharemyscreen = options.sharemyscreen || false;
    this.stream = options.stream;
    // Create an RTCPeerConnection via the polyfill
    this.pc = new RTCPeerConnection(this.parent.config.peerConnectionConfig, this.parent.config.peerConnectionContraints);
    this.pc.onicecandidate = this.onIceCandidate.bind(this);
    if (options.type === 'screen') {
        if (this.parent.localScreen && this.sharemyscreen) {
            logger.log('adding local screen stream to peer connection')
            this.pc.addStream(this.parent.localScreen);
            this.broadcaster = this.parent.connection.socket.sessionid;
        }
    } else {
        this.pc.addStream(this.parent.localStream);
    }
    this.pc.onaddstream = this.handleRemoteStreamAdded.bind(this);
    this.pc.onremovestream = this.handleStreamRemoved.bind(this);
    // for re-use
    this.mediaConstraints = {
        mandatory: {
            OfferToReceiveAudio: true,
            OfferToReceiveVideo: true
        }
    };
    WildEmitter.call(this);

    // proxy events to parent
    this.on('*', function (name, value) {
        self.parent.emit(name, value, self);
    });
}

Peer.prototype = Object.create(WildEmitter.prototype, {
    constructor: {
        value: Peer
    }
});

Peer.prototype.handleMessage = function (message) {
    if (message.type === 'offer') {
        logger.log('setting remote description');
        this.pc.setRemoteDescription(new RTCSessionDescription(message.payload));
        this.answer();
    } else if (message.type === 'answer') {
        logger.log('setting answer');
        this.pc.setRemoteDescription(new RTCSessionDescription(message.payload));
    } else if (message.type === 'candidate') {
        var candidate = new RTCIceCandidate({
            sdpMLineIndex: message.payload.label,
            candidate: message.payload.candidate
        });
        this.pc.addIceCandidate(candidate);
    }
};

Peer.prototype.send = function (type, payload) {
    this.parent.connection.emit('message', {
        to: this.id,
        broadcaster: this.broadcaster,
        roomType: this.type,
        type: type,
        payload: payload
    });
};

Peer.prototype.onIceCandidate = function (event) {
    if (this.closed) return;
    if (event.candidate) {
        this.send('candidate', {
            label: event.candidate.sdpMLineIndex,
            id: event.candidate.sdpMid,
            candidate: event.candidate.candidate
        });
    } else {
      logger.log("End of candidates.");
    }
};

Peer.prototype.start = function () {
    var self = this;
    this.pc.createOffer(function (sessionDescription) {
        logger.log('setting local description');
        self.pc.setLocalDescription(sessionDescription);
        logger.log('sending offer', sessionDescription);
        self.send('offer', sessionDescription);
    }, null, this.mediaConstraints);
};

Peer.prototype.end = function () {
    this.pc.close();
    this.handleStreamRemoved();
};

Peer.prototype.answer = function () {
    var self = this;
    logger.log('answer called');
    this.pc.createAnswer(function (sessionDescription) {
        logger.log('setting local description');
        self.pc.setLocalDescription(sessionDescription);
        logger.log('sending answer', sessionDescription);
        self.send('answer', sessionDescription);
    }, null, this.mediaConstraints);
};

Peer.prototype.handleRemoteStreamAdded = function (event) {
    var stream = this.stream = event.stream,
        el = document.createElement('video'),
        container = this.parent.getRemoteVideoContainer();

    el.id = this.getDomId();
    attachMediaStream(el, stream);
    if (container) container.appendChild(el);
    this.emit('videoAdded', el);
};

Peer.prototype.handleStreamRemoved = function () {
    var video = document.getElementById(this.getDomId()),
        container = this.parent.getRemoteVideoContainer();
    if (video && container) {
        container.removeChild(video);
        this.emit('videoRemoved', video);
    }
    this.parent.peers.splice(this.parent.peers.indexOf(this), 1);
    this.closed = true;
};

Peer.prototype.getDomId = function () {
    return [this.id, this.type, this.broadcaster ? 'broadcasting' : 'incoming'].join('_');
};

// expose WebRTC
window.WebRTC = WebRTC;

}());
