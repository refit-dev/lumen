#!/bin/bash

# SSH Tunnel Script for Ramon DevBox
# Tunnels ports 3000 and 8000 from remote server to local machine

echo "Creating SSH tunnel to ramon-devbox..."
echo "Local port 3000 -> Remote port 3000"
echo "Local port 8000 -> Remote port 8000"
echo ""
echo "Press Ctrl+C to close the tunnel"
echo ""

# Create SSH tunnel with port forwarding
# -L: Local port forwarding
# -N: Don't execute remote command (just forward ports)
# -T: Disable pseudo-terminal allocation
ssh -L 3000:localhost:3000 -L 8000:localhost:8000 -N -T ramon-devbox