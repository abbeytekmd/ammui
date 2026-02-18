# Abbeytek Media Machine (AMMUI)

A web based media manager for a home network. This is what I wanted to be able to use to play music and view our family photos.

* Play music from local servers (Subsonic, minidlna, etc.)
* Send to local players. (Sonos, etc.)
* Includes a local DLNA server where you can download music/photos to.
* Display a slideshow of photos from a local server. Modes are All, This day, Favorites, Music (currently playing album art)
* Set home folders for Music Browsing, Photo Browsing and Slideshow.

I'm running this on my linux home server, with a 10" tablet running the UI in Chrome.

It'll also sit on a Raspberry Pi with an Audio HAT and gmrender-resurrect/mpd/upmpdcli to make an all in one server/player.

Although I can code, I've chosen to concentrate on iterating on the product design and used AI to do the boilerplate.

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
