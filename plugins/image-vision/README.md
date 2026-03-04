# Image Vision Plugin for NanoClaw

This plugin adds image processing capabilities to NanoClaw, allowing Claude to analyze visual content from images sent via WhatsApp.

## Features

- Download images from WhatsApp messages
- Save images to group-specific media folders
- Pass images to Claude agent for visual analysis
- Automatic cleanup of old images (configurable retention)
- Support for images, videos (first frame), and documents

## Installation

1. Install the plugin:
   ```bash
   npm install --save @whiskeysockets/baileys
   ```

2. Enable the plugin in `data/registered_groups.json`:
   ```json
   {
     "120363424913709624@g.us": {
       "name": "Eurotrip",
       "folder": "eurotrip",
       "trigger": "@Case",
       "plugins": {
         "image-vision": {
           "enabled": true,
           "maxMediaAge": 7,  // days to keep media files
           "maxFileSize": 10485760  // 10MB max
         }
       }
     }
   }
   ```

3. The plugin will automatically:
   - Download images when messages with media are received
   - Save to `/workspace/project/groups/[group]/media/`
   - Pass image paths to Claude for analysis
   - Clean up old media files daily

## Usage

Users can send images with captions containing `@Case`:
- "✅ @Case what monument is this?"
- "✅ Extract the flight info from this ticket @Case"
- "✅ Read this menu @Case"

## Technical Details

- Images saved as: `[timestamp]-[messageId].jpg`
- Videos: first frame extracted as JPEG
- Documents: rendered as images if possible
- Automatic retry on download failure
- Thread-safe with async/await patterns

## File Structure

```
plugins/image-vision/
├── README.md           # This file
├── index.ts            # Plugin entry point
├── downloader.ts       # Media download logic
├── cleaner.ts          # Old media cleanup
└── types.ts            # TypeScript interfaces
```
