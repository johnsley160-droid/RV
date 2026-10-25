# RV Kitchen POS — Railway Edition

Everything in one folder: a small Express server (`server.js`) serves the app and its API, and
the app itself is a single-file PWA. Deploy the whole folder to Railway and you get a live URL,
then turn that into an installable Android/iOS/Windows app with PWABuilder.

```
rv-kitchen-pos/
├── server.js               → Express server: serves the app + the /api backend
├── package.json            → dependencies (just Express) and the start script
├── index.html              → the whole app (menu, photos, logo built in)
├── manifest.webmanifest    → app identity for PWABuilder
├── sw.js                   → service worker (offline + instant loading)
├── icons/                  → 7 app icons made from your real logo
├── screenshots/            → drop your own screenshots here (optional)
└── README.md               → this file
```

The app is in Spanish for your staff. This file is in English for you.

---

## NEW: Online ordering for customers (`/pedir`)

Your customers now have their own app at **`https://your-app.up.railway.app/pedir`**.
Anyone can open it on their phone. No login and no code needed. It only shows the customer side:
menu with photos and options, cart, delivery details, and live order status.
It does **not** show the register, kitchen, reports, or other customers' orders.

**What the customer does**
1. Picks items from your menu (same items, prices, photos and options as the register).
2. Enters name, phone/WhatsApp, sector, address, a reference ("casa verde al lado del colmado")
   and, optionally, a Google Maps / WhatsApp location link.
3. Chooses cash (and how much they'll pay with) or card on delivery.
4. Sees a tracker: Recibido → En cocina → Listo → Entregado. It updates by itself.

**What you see**
- The order lands on the **Cocina** board like any other order, labeled **Delivery · En línea**, marked **Sin cobrar**.
- Open it in **Órdenes** to see the address, reference, phone, and a button **Abrir ubicación del cliente en el mapa**.
- When the driver comes back with the money, press **Cobrar** as usual.
- Moving the order through the kitchen (Empezar → Marcar listo → Entregar) is what the customer sees on their phone.

**Prices are always the server's.** The phone only says which items and options were picked;
the server recalculates every price from your menu, adds the delivery charge and ITBIS from **Ajustes**,
exactly like the register. Products you mark as *agotado* disappear from the customer app.

### Must do before you share the link: set an access code

Once the customer link is public, the staff side must be locked. In Railway → your service → **Variables**:

| Variable | Value | Why |
|---|---|---|
| `RV_ACCESS_CODE` | a secret word only staff know, e.g. `rvcocina2026` | Without it, anyone could read your orders and customer addresses from the staff API. Each register/tablet asks for it once. |
| `RV_ONLINE_ORDERS` | `off` | Optional. Pauses online ordering (customers see "no estamos recibiendo pedidos"). Delete it or set `on` to reopen. |
| `RV_TIMEZONE` | `America/Santo_Domingo` | Optional, already the default. Online orders are filed under the restaurant's day. |

The customer app never needs the access code.

### Share it with customers
- Put `https://your-app.up.railway.app/pedir` in your Instagram bio, WhatsApp Business greeting, and a QR code on the counter and delivery bags.
- On the phone, customers can tap **Add to Home Screen** and get an **RV Delivery** icon with your logo.

### New and changed files
- `pedir.html` — the customer app
- `pedir.webmanifest` — its home-screen icon and name
- `menu-default.json` — the menu the server uses until you save a menu from **Menú** in the register
- `photos/` — the menu photos and logo served to customers
- `server.js` — new public routes under `/api/public/*`; order saves are now one at a time so two orders arriving together never overwrite each other
- `index.html` — order detail shows the customer's map link; kitchen cards say "En línea"
- `sw.js` — the register's offline cache no longer intercepts `/pedir` or `/admin`

---

## NEW: Admin panel (`/admin`) and the specialties slideshow

**Your admin link:** `https://your-app.up.railway.app/admin`

**Sign in:** username **ADMIN**, password **Admin01**. Change the password right away in **Settings** (the panel reminds you until you do). You stay signed in on that device for 30 days, even if the server restarts. Forgot the admin password? In Railway → Variables, add `RV_ADMIN_PASSWORD` with a new password and let it redeploy; sign in with it, then delete that variable (otherwise it puts that password back on every restart).

### Saving data automatically
Everything (orders, customer accounts, menu, employees, slideshow photos, admin password) is saved on the server as it happens. To make it **permanent**, attach a **Volume** to the service in Railway (mount path `/data`). The app finds the volume by itself — no variable needed. Until a volume is attached, the admin panel shows a red warning, because Railway erases unsaved files on every update or restart.

### Separate web addresses for the app and the admin panel (optional)
Both are already on different links (`/pedir` and `/admin`) and always share the same data. To give each its own address, for example `pedir.rvkitchen.com` for customers and `admin.rvkitchen.com` for you:
1. Buy a domain (for example `rvkitchen.com`) from any domain seller, if you don't have one.
2. Railway → your RV Kitchen service → **Settings → Networking → Custom Domain**: add `pedir.rvkitchen.com`, then add `admin.rvkitchen.com`. Railway shows a **CNAME** record for each.
3. At your domain seller, open the DNS settings and add those two CNAME records exactly as Railway shows them. Wait until Railway shows them as active (minutes to a few hours).
4. Railway → **Variables**: add `RV_SHOP_DOMAIN` = `pedir.rvkitchen.com` and `RV_ADMIN_DOMAIN` = `admin.rvkitchen.com`.

Result: the customer address shows only the ordering app (no register, no admin). The admin address opens straight into the admin panel, and its **Customer app** button goes to the customer address. Your `.up.railway.app` address keeps working for the register.

### Inventory tab (new)
Keeps track of your ingredients and supplies, and connects them to the register and the customer app.
- **Ingredients:** name, unit (unid, lb, botella…), how many you have, the level that should warn you, and cost per unit (optional, for "Stock value").
- **Quick start:** tap **Load RV Kitchen starter list** to add 14 common ingredients (pan, carne, queso, papas, sodas, agua…) with recipes for your menu. Then use **Count** to type what is really on the shelf.
- **Buttons per ingredient:** **+ Add** when supplies arrive, **Count** to set the real amount, **− Remove** for anything spoiled or used outside a sale.
- **Recipes:** what one of each menu item uses (e.g. Combo 2 = 1 pan + 1 carne + 1 queso + 0.33 lb papas). **Options and extras** add on top (e.g. the combo's drink choice "Coca-Cola" = 1 soda; "Queso extra" = 1 queso).
- **Automatic:** every sale from the register and the online app subtracts the ingredients; cancelling an order puts them back; editing an order adjusts the difference.
- **Not counted yet:** a new ingredient has no count, so it never marks anything sold out until you enter one.
- **History:** the latest sales, cancellations, deliveries, counts and removals.

**What the register shows:** **Agotado** (red) or **Quedan pocos** (yellow) on products and drink choices, plus a warning when staff tap one. Staff can still sell it, and stock can go below zero, so count again after a delivery.
**What customers see:** sold-out items and drink choices show **Agotado** and can't be ordered online.

### Settings tab
- **Saving your data:** green when storage is permanent, red with the steps when it is not.
- **Admin sign-in:** change the username or password (signs out every other device).
- **Start fresh:** erase all test orders/sales numbers and/or all customer accounts (type ERASE to confirm). Menu, prices, photos, employees, settings and slideshow are kept. Use it once before opening to the public.

The register (`/`) still uses `RV_ACCESS_CODE` for staff. Set it so nobody else can open your register or read orders.

### Sales tab
- **At a glance:** money and number of orders for **Today, This week, This month, All time**.
- **Day / Week / Month / All:** pick a period, then use the ◀ ▶ arrows to go back in time.
- For each period: orders, money in sales (collected vs. not paid yet), average order, cancelled orders, and the change vs. the previous period.
- Chart by hour (day), by day (week/month) or by month (all). Switch between **Money** and **Orders**. Point at or tap a bar to see its numbers.
- Breakdowns: online app vs. register, payment method (cash / card / transfer), order type (delivery / takeout / dine-in).
- Best sellers and the list of orders for the period.
- Filter everything to **All orders**, **Online app** only, or **Register (in store)** only.
- Weeks start on Monday. Days follow Dominican Republic time (change with `RV_TIMEZONE` if needed).

### Slideshow tab
The top of the customer app (`/pedir`) is a slideshow of your specialties, changing every **4 seconds** (you can change the seconds).
- **Add slide** → pick a photo from your phone or computer. It is shrunk automatically before upload.
- Edit the **Title** and **Subtitle** (customers see these, so write them in Spanish).
- **When tapped, open:** choose a menu item, so tapping the slide opens that item ready to add to the cart.
- **Showing / Hidden** switch, move up / down, delete.
- Tap **Save changes**. Customers see the new slideshow right away.
- **Restore starter slides** brings back the original three.
- Uploaded photos are saved in your data folder (`DATA_DIR/slides`), so attach a Railway volume (see section 1) or they are lost on redeploy.

### Customer accounts (new)
Customers must **create an account before placing an order**. They can look at the menu and fill the cart without one.
- **Sign up:** name, phone/WhatsApp (10 digits) and a password (6+ characters). One account per phone number.
- On the **Tu pedido** screen, customers without an account see **Crear cuenta** / **Ya tengo cuenta**. After signing up they go straight back to their order with name and phone filled in.
- The delivery address is saved on the account after the first order and filled in automatically next time. Customers can edit it in **Cuenta → Mi dirección de entrega**.
- Signed-in customers see their orders on **any phone** (Mis pedidos).
- **Forgotten password:** there is no SMS. The customer calls or writes to you. In the admin panel, open **Customers**, find them, tap **Reset password** twice, and give them the new 6-digit password. That also signs them out on every phone.
- Passwords are never stored, only a scrambled version (scrypt hash). Accounts live in `DATA_DIR/customers.json`, so a Railway volume keeps them safe across redeploys.

### Customers tab (admin)
List of customer accounts with phone (tap to open WhatsApp), sector, date joined, number of orders, money spent and last order. Search by name, phone or sector. Totals for customers, new this month, repeat customers, and customers who never ordered.

### Files for this feature
- `admin.html` — the admin panel
- `photos/sl-1.jpg`, `sl-2.jpg`, `sl-3.jpg` — the three starter slides
- `server.js` — new `/api/public/slides` (customers) and `/api/admin/*` (protected) routes; the server also refuses to serve its own files and the `data` folder as web pages

---

## 1. Deploy to Railway

**Easiest path — from a GitHub repo:**

1. Push this whole folder to a new GitHub repository.
2. Go to **railway.app** → **New Project** → **Deploy from GitHub repo** → pick the repo.
3. Railway detects `package.json`, runs `npm install`, and starts the app with `npm start`.
   No build configuration needed.
4. Once it deploys, open **Settings → Networking → Generate Domain** to get a public URL like
   `rvkitchen-production.up.railway.app`.

**Alternative — Railway CLI, no GitHub required:**

```bash
npm install -g @railway/cli
railway login
cd rv-kitchen-pos
railway init
railway up
railway domain      # generates the public URL
```

### Make your data survive redeploys — attach a volume

By default the app stores orders, menu, and staff as JSON files on local disk, which Railway
wipes on every redeploy. Fix that once:

1. In your Railway project → your service → **Settings → Volumes → New Volume**.
2. Mount path: `/data`.
3. Add an environment variable: `DATA_DIR = /data`.
4. Redeploy. From then on, every deploy reuses the same disk.

### Confirm the backend is live

Open `https://your-app.up.railway.app/api/health`. You should see:

```
{"ok":true,"store":"filesystem","dataDir":"/data",...}
```

That means orders, employees, and menu changes are being saved on the server and shared
by every terminal. In the app itself, the chip in the top right will read **Guardado** in green.

### Set your access code

Railway service → **Variables** → add:

```
RV_ACCESS_CODE = whateverCodeYouPick
```

Redeploy (Railway does this automatically when you save a variable). Each device asks for the
code once and remembers it. Without this, anyone with the link can open your system.

### Custom domain (optional)

Service → **Settings → Networking → Custom Domain**, then point your DNS at the CNAME Railway
gives you.

---

## 2. Codes

| Who | Code | Opens on |
|---|---|---|
| Administrador | `0123` | Vender — full access |
| Cocina | `1234` | Cocina — kitchen board only |

Add the rest of your staff in **Empleados**, then change these two.

---

## 3. Build the app with PWABuilder

Once the Netlify site is live:

1. Go to **pwabuilder.com**
2. Paste your URL (`https://rvkitchen.netlify.app`) and press **Start**.
3. It scores the manifest, service worker, and security. All three should pass — the manifest
   and service worker in this pack are built for it.
4. Press **Package for stores** and pick your platform:
   - **Android** — downloads a signed `.aab` for Google Play plus an `.apk` you can install
     directly on a tablet for testing. **Keep the `signing.keystore` file and its password
     somewhere safe** — without it you can never update the app on Play.
   - **iOS** — produces an Xcode project. Publishing to the App Store needs a Mac and an
     Apple Developer account ($99/year).
   - **Windows** — produces an `.msix` for the Microsoft Store.

### Before submitting to Google Play

Play requires screenshots of the running app. Take them on your tablet, then either upload
them straight to the Play Console listing, or drop them in the `screenshots/` folder here and
add them to the manifest. Two or three are enough — the register with the product grid, the
kitchen board, and a report.

### You don't actually need PWABuilder

On the tablet, open the site in Chrome → menu → **Add to Home Screen**. You get the same
full-screen app with your logo as the icon, and it updates itself whenever you redeploy.
PWABuilder is only needed if you want it listed in an actual app store.

---

## 4. If the header says "Guardado aquí"

The site works, but each terminal saves separately and nothing follows you between devices.
It means either the server isn't reachable at `/api/*`, or (more likely on Railway) the disk
holding the data got reset on a redeploy because no volume is attached.

1. Open `https://your-app.up.railway.app/api/health` directly. If that 404s or errors, the
   server itself isn't running — check **Deployments** in Railway for a crash log.
2. If health returns `"dataDir":"/data"` but data still resets, confirm the volume is actually
   mounted at `/data` on the service (Settings → Volumes) and that `DATA_DIR=/data` is set in
   Variables.
3. If `dataDir` shows something other than `/data`, the `DATA_DIR` variable isn't set — add it
   and redeploy.

---

## 5. Tablet gestures

- **Swipe right from the left edge** — open the side menu
- **Swipe left** — close it
- **Swipe left or right on the products** — change category
- **Swipe left from the right edge** — open the order panel
- **☰ button** — collapse the sidebar for a wider product grid
- The kitchen board scrolls sideways between its three columns on small screens

Icon shortcuts: long-press the installed app icon for **Vender**, **Cocina**, and **Reportes**.

---

## 6. Employees and the time clock

**Empleados** (admin only). Each person gets a name, a 4-digit code, and a role:

- **Administrador** — everything, including voiding orders and editing the menu
- **Cajero** — sell, kitchen board, view orders
- **Cocina** — kitchen board only

The code is both their login and their time clock: entering it marks their entry, pressing
**Salir** marks their exit. **Ver marcajes** shows the log with hours and exports to CSV.
A green dot means that person is on shift right now.

The system won't let you remove your last administrator, so you can't lock yourself out.

**Reportes** has a per-employee table: orders, sales, average ticket, shifts, hours worked,
and sales per hour.

---

## 7. Before the first shift

1. **Ajustes** → business name, RNC, address, phone, receipt message
2. **Ajustes** → ITBIS rate and the *"Los precios ya incluyen ITBIS"* checkbox — decide this
   before you sell anything, it changes every ticket
3. **Ajustes** → cash float, delivery charge, kitchen alert minutes
4. **Ajustes** → light or dark mode (saved per screen, so the kitchen can stay dark)
5. **Empleados** → add staff, change the two default codes
6. **Menú** → confirm every price

---

## 8. Menu and photos

All 24 items from your printed board at your prices, including the Grande option that takes
a soda from RD$75 to RD$100. 22 items use the photography from your own menu artwork; Jugo
Natural and Agua show the RV Kitchen crest.

To replace a photo: **Menú** → click the small square on a row, or open *Editar*. Photos are
cropped and compressed in the browser — a 4 MB phone picture becomes about 30 KB — and sync
to every terminal.

Menu edits live on the server and survive redeploys.

---

## 9. Where your data is saved

The chip in the top right tells you, at all times, where your work is going:

| Chip | Meaning |
|---|---|
| **Guardado** (green) | Saved on the server. Every terminal sees it. This is what you want. |
| **Guardado aquí** (yellow) | Saved on this device only. Other terminals can't see it. |
| **3 por enviar** (yellow) | Saved here, waiting for the internet to send it up. Empties by itself. |
| **SIN GUARDAR** (red) | This browser is blocking storage. Nothing will survive closing the tab. |

### If orders or employees disappear between sessions

Check that chip. If it says **Guardado aquí**, the backend isn't running — your data is stuck
on one device and won't follow you to another browser or another tablet.

This is the single most common cause: the site was deployed with only `index.html` instead of
the full folder, so `netlify/functions` never made it up. Redeploy the whole
`rv-kitchen-pack` folder and the chip should turn green.

To confirm the backend is live, open `https://your-site.netlify.app/api/health` — you should
see `{"ok":true,...}`. If you get Page Not Found, the function isn't deployed.

**SIN GUARDAR in red** means you're viewing the app somewhere that blocks browser storage —
a preview window, a sandboxed frame, or private browsing with storage disabled. Open the real
Netlify URL in a normal browser tab.

### Nothing is lost when the internet drops

Every action is written to the device first, then sent to the server. The sale is saved before
the send is even attempted. The register keeps working, the chip shows how many items are
waiting, and the queue empties by itself when the connection returns. Order numbers get
reassigned by the server so two terminals never collide.

The queue survives a refresh, a crash, and the tablet being switched off.

While a terminal is offline, other terminals can't see its orders yet. Nothing is lost, just
delayed.

### Weekly backup

**Ajustes** → **Descargar respaldo** gives you one file with the menu, employees, clock log,
and the last 120 days of orders. Save it to Google Drive once a week. **Restaurar respaldo**
loads it back if you ever rebuild on new hardware.

---

## 10. Unpaid orders, editing and deleting

**Two ways to send an order to the kitchen:**

- **Cobrar** — take payment now, the normal counter flow.
- **Sin cobrar** — send it to the kitchen unpaid. For delivery where the driver collects, or a
  table that pays at the end. It shows **Sin cobrar** in red on the orders list.

To collect later: **Órdenes** → open the order → **Cobrar RD$…**. That opens the payment
screen, records the change, and prints the receipt.

**Editing (Administrador and Cajero).** An order can be edited while it is *not yet paid* and
*not delivered or voided*. Open it and press **Editar** — the items load back into the
register, where you can add, remove, or change quantities, then press **Guardar cambios**. The
kitchen sees the update. Once an order is paid, the Editar button disappears; use **Anular**
instead.

Every edit records who made it, shown in the order detail.

**Deleting (Administrador only).** The order detail has **Eliminar**, which removes the order
permanently — it won't appear in reports or the cash close. Use it for a mistake that should
never have existed.

Prefer **Anular** for a real order that was cancelled. Voided orders stay visible in the
history and are excluded from sales totals, which is what you want for an audit trail.

---

## 11. Updating later

Change files, commit, and push to GitHub (or run `railway up` again with the CLI) — Railway
redeploys automatically. Your data isn't touched as long as the volume stays attached: orders,
menu edits, employees, and clock entries live on the mounted disk, not in these files.

The service worker refreshes the app on the next open after a deploy.

---

## Environment variables

| Variable | Required | What it does |
|---|---|---|
| `RV_ACCESS_CODE` | Recommended | Keeps the public out of your system |
| `DATA_DIR` | Recommended on Railway | Where JSON data is stored — point it at your mounted volume, e.g. `/data` |
| `PORT` | No | Set automatically by Railway; only needed for local testing |

## Running locally

```bash
npm install
RV_ACCESS_CODE=1234 npm start
# open http://localhost:3000
```

## Spanish terms in the app

| In the app | Meaning |
|---|---|
| Vender | Sell / new order |
| Cocina | Kitchen |
| Órdenes | Orders |
| Menú | Menu |
| Empleados | Employees |
| Reportes | Reports |
| Ajustes | Settings |
| Marcajes | Clock in/out log |
| En turno | On shift |
| Cobrar | Charge / take payment |
| Devuelta | Change owed to customer |
| Cierre de caja | End-of-day cash close |
| Agotado | Sold out |
| Anular | Void |
| Para llevar / Comer aquí | Takeout / Dine in |
