# Garage Door Install Tracker

A mobile-friendly garage door installation tracking app hosted on GitHub Pages with Supabase for private data storage and authentication.

## Features

- Email/password sign-in
- Add, edit, and delete installation records
- Address, manufacturer, model number, door size, spring size/count, door type, color, lift type, install date, customer name, and notes
- Search across records
- Installation map using OpenStreetMap + Leaflet
- Automatic address geocoding when possible
- CSV export
- Phone, tablet, and desktop layout
- Home-screen/PWA support

## Security

Customer installation data is **not stored in this public GitHub repository**. Records are stored in Supabase. Row Level Security restricts each signed-in user to their own records.

The browser uses only the Supabase publishable key. Never commit a Supabase secret key or service-role key.

## One-time Supabase setup

1. Open the Supabase project.
2. Open **SQL Editor**.
3. Create a new query.
4. Copy the entire contents of `supabase-schema.sql`.
5. Run it once.
6. Open the web app and use **Create account**.

After your account is created, you can optionally disable new-user signups in Supabase if only you should have access.

## GitHub Pages setup

In this repository, go to **Settings > Pages** and choose:

- Source: **Deploy from a branch**
- Branch: **main**
- Folder: **/(root)**

Save the setting. GitHub will publish the app at the repository's GitHub Pages address.
