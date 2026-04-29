# History

Reck Connect's current station/satellite design replaced an earlier
prototype that brokered everything through a Cloudflare Worker. The
earlier code is not part of this repository.

The motivation for the rewrite: eliminate cloud dependency, give the
user direct ownership of all daemon state, simplify auth to a single
bearer token, and replace asynchronous message-passing with synchronous
PTY-over-WebSocket so the satellite renders panes that feel like local
terminals.
