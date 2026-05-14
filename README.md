# Matrix Gallery v0.31.0

This extension imports chat data exported with the mattermost-exporter extension (https://github.com/HighIander/mattermost-exporter) into a single matrix chat and is compatible with the matrix-gallery extension (https://github.com/HighIander/matrix-gallery). 

The extension injects an import button (labeled "MM") in the Matrix webpage at the bottom right. 
The script tries to identify the corresponding team/channel in the export data based on the space/chat names, but the user can also select the corresponding channel manually. Start date for import can be chosen. The matrix chat is checked for duplicates before import. Supports images, other files, emojis and threads. 

Licence: None (use as you like). No liability is taken by the author!

## Features

- Import chat data into the current open chat in Matrix (i.e. open the chat where you want to import your data first).
- Selection of the export directory on your computer.
- Automatic guessing of the Mattermost channel in the export data that corresponds to the active Matrix chat; user can manually choose the channel as well.
- Detects duplicates and skips those messages.
- Support for emojis, markup and threads.
- Writes multiple images in Mattermost messages to Matrix in a form compatible with the matrix-gallery extension (https://github.com/HighIander/matrix-gallery) in order to view it nicely as used to from Mattermost!
- Progress bar and cancel button during export.


## Installation

0. Download all files from this repository into a directory on your computer, e.g. to [downloads/matrix-mattermost-importer]


### Chrome/Edge

1. Open `chrome://extensions/` or `edge://extensions/`.
2. Enable developer mode.
3. Click “Load unpacked”.
4. Select the extension download folder , e.g. [downloads/matrix-mattermost-importer]
5. Open Mattermost in the browser.
6. Click the lower-left `export` button.

### Firefox [not tested!]
1. Open `about:debugging#/runtime/this-firefox`
2. Click "Load Temporary Add-on"
3. Select `manifest.json` from the download folder, e.g. [downloads/matrix-mattermost-importer/manifest.json]

## Notes

The extension uses your active Matrix browser session. It does not need a Matrix access token or admin permissions. 

For reading the Mattermost export folder, the browser must support the File System Access API. This usually means Chrome, Edge, or Firefox on HTTPS/localhost.


