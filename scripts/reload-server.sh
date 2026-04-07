#!/bin/bash
# Reloads the fleet manager server by sending SIGHUP to its process

PID=$(pgrep -f "python.*fleet_manager.server" | head -1)

if [ -z "$PID" ]; then
    echo "Error: Fleet manager server not running"
    exit 1
fi

echo "Sending SIGHUP to fleet manager (PID: $PID)"
kill -HUP "$PID"
echo "Done"
