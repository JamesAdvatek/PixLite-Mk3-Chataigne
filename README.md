# PixLite Mk3 for Chataigne

Experimental community module for triggering stored SHOWTime scenes and
playlists on Advatek PixLite Mk3 controllers. Chataigne is control software for
artists and technicians building shows and interactive installations.

Uses Chataigne's built-in WebSocket Client over `ws://` on port 80, with operator
access only. No bridge or Node.js runtime is required. This is a community
project, not an Advatek engineering release.

## Status

Early community preview for testing and feedback. Scene and playlist playback,
Pause, Resume, Next, Live, Blank and Freeze have been checked with A4-S Mk3 and
E16-S Mk3 controllers on Windows using Chataigne 1.10.5b13. Feedback mapping,
manual installation and save/reopen have also been checked. Reported status is
not proof of emitted light, and this is not a live-show release.

Requires a build from the latest Chataigne master with the WebSocket changes
Ben has approved and merged, including the [empty-address startup fix](https://github.com/benkuper/Chataigne/pull/362).
The tested Windows 1.10.5b13 download failed the Unicode-password
authentication check. A matching version number alone does not establish compatibility.

## Setup

1. Put `module.json` and `moduleScript.js` in a `PixLiteMk3` folder in Chataigne's
   user module library, then reload modules.
2. Add one instance per controller and enter **Device address**. For a direct
   connection, the computer and controller need addresses on the same subnet.
3. Before launching Chataigne, set the operator password in the environment
   variable named by **Operator password variable**. Its default name is
   `PIXLITE_OPERATOR_PASSWORD`. An absent or empty variable means an empty
   password. For different device passwords, use a different variable per instance.
4. Run **Verify connection**. The module reads identity, status and media before
   allowing playback commands. It never attempts administrator access.

The package contains the module, script, this README and the MIT licence.

## Controls and feedback

Use **Play scene** or **Play playlist** and enter the full stored filename,
including `.scn` or `.pl`, for a cue. Names without an extension use the media
list. If that list is over five seconds old, the first trigger refreshes it;
trigger again within five seconds of the refresh to play. The **Available media** list groups
scenes and playlists without their extensions. **Refresh media** reloads the
list. An empty filename sends nothing.

Other commands are **Pause**, **Resume**, **Next playlist item**, **Live**,
**Blank** and **Freeze**. No output command is sent on connection, project load
or reconnection.

Status notifications update feedback. After two seconds without status, an idle
instance requests a refresh. Only one request is in flight. Status older than
five seconds blocks commands. Reported status does not prove physical output.

**Connection** shows short errors. **Last command** distinguishes Pending,
Acknowledged, Rejected and Unknown. Only a matching API response acknowledges a
command. The request deadline is 1800 ms, with a separate three-second callback
ceiling. Output commands are never retried or replayed automatically.

After a connection fault, re-enable the instance and run **Verify connection**.
After **Unknown**, independently check the controller before creating a fresh
instance. A saved pending-command marker keeps unresolved outcomes blocked after
project reload.

## Network and credentials

Use a trusted LAN. Plain WebSocket sends the authentication hash unencrypted.
The module stores the password variable's name rather than its password. The
authenticated server path is hidden and marked read-only to exclude its value
from ordinary saves. The checked native projects and application logs contained
no authenticated connection URLs. This has not been checked for every host log, undo record or
crash dump.

Configuration, uploads, firmware, discovery and recovery are outside this module.

[Community discussion](https://discord.com/channels/697400442027769998/1565677428406358088)
