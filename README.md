# UI for an Abbeytek Media Machine (AMMUI)

A web based media manager for a home network. Plays music and views family photos.

* Play music from local servers (Subsonic, MiniDLNA/ReadyDLNA, etc.)
* Send to local players. (Sonos, DLNA players, etc.)
* Includes a local DLNA server where you can download music/photos to.
* Display a slideshow of photos from a local server. Modes are: All, On this day, Favorites, Music (currently playing album art)
* Set home folders for Music Browsing, Photo Browsing and Slideshow.

I'm running this on my linux home server, with a 10" tablet running the UI in Chrome.

The Abbeytek Media Machine is basically a Raspberry Pi with an Audio HAT and gmrender-resurrect/mpd/upmpdcli. Adding this UI makes it an all in one server/player.

Although I can code, I've chosen to concentrate on iterating on the product design and used AI to do the boilerplate.

## Slideshow:
* Apply rotation to photos and the server will remember.
* Delete a photo to hide it from the slideshow in future.
* Go back to the last picture in the slideshow in case you just missed it.
* Pause and adjust volume of current player without existing the slideshow.
* Photos with location data will show a small map overlay showing where they were taken.

## Local DLNA Server
* Upload button to upload tracks and photos from local disk.
* Download buttons on music and photos to download to the local server.
* Sync local music and photos to S3.

## 🚀 Getting Started

### Prerequisites
*   Node.js (v18 or higher)
*   npm

### Installation

1.  Clone the repository:
    ```bash
    git clone https://github.com/abbeytekmd/ammui.git
    cd ammui
    ```

2.  Install dependencies:
    ```bash
    npm install
    ```

### Usage

1.  Start the application:
    ```bash
    npm start
    ```

2.  Open your browser and navigate to:
    ```
    http://localhost:3000
    ```

## ⚙️ Built With

*   **Node.js & Express** - Backend server
*   **node-ssdp** - UPnP/DLNA discovery
*   **sonos** - Sonos device support
*   **Vanilla JS & CSS3** - Frontend interface

## 📄 License

This project is licensed under the ISC License.
