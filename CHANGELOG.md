-----
20MAY26 Claude Code

- Added EP (Electronic Protection) mode: a separate workbench for placing friendly nodes with named sub-systems, each with its own frequency, TX power, and gain
- EP systems generate terrain-aware detection rings in auto-assigned colors using the existing ES terrain API
- EP mode toggle button added to workbench header; sidebar swaps to EP-specific settings (terrain type, enemy RX sensitivity) when active
- EP nodes coexist with existing red/blue/black EA nodes — switching modes does not clear the map
- Added delete button to EP node popup, matching the existing red/blue/black node behavior (left-click → "Remove Node")
- Ring labels (ES detection, jammer footprint, EP system rings) moved from polygon center to the rightmost edge point so they no longer clutter the area around the node
- Multiple EP system labels on the same node are staggered 20px apart vertically so they do not stack on top of each other
- EP nodes are now included in the "Center on Nodes" map fit
- "Center on Nodes" now also extends bounds to include active jammer footprint rings (blue nodes) and EP system rings, not just ES rings

-----
