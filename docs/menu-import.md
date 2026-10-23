# Chick Buck Vengara menu

The checked menu data is in `data/menus/chick-buck-vengara.json`. It was transcribed from the user's 10-page scanned PDF, `laaaaaaaaaaaaadt.pdf`. Pages 1 and 10 are cover/contact pages. Pages 2–9 contain 125 selectable items across 19 categories.

- Combo descriptions retain the printed chicken/khubz quantities and included sides.
- Drink names include their category so kitchen tickets can distinguish, for example, Mango Lime, Mango Fresh Juice and Mango Shake.
- The printed Lime Soda (Sweet / Salt) row becomes two products with the same Rs 25 price.
- The Ketchup add-on is Rs 1 as printed. The combined Pista | Badam | Cashew dry fruit shake remains one product, as printed.
- Prices are copied exactly. The food pages state GST included. `additionalTaxRateBps: 0` prevents adding the demo surcharge to the printed amounts. This is not a calculation of the included statutory tax; an inclusive-tax breakdown still requires separate business configuration and implementation.

## Preview and apply

The script connects only to `127.0.0.1:3017`. The supplied HTTPS origin is the server's expected Host/Origin header; account credentials are never sent through the public tunnel by this script.

```powershell
node scripts/import-menu.cjs data/menus/chick-buck-vengara.json https://YOUR-SERVER web-data/mobile-test/credentials.json
node scripts/import-menu.cjs data/menus/chick-buck-vengara.json https://YOUR-SERVER web-data/mobile-test/credentials.json --apply
```

The first command previews the import. The second uses the owner's existing authenticated management APIs and saves a database snapshot before changing the catalog. Owner credentials and branch ID are read from the ignored local credentials file. The imported branch must match the file's branch ID.

The replacement reuses the five known demo category IDs if their original names still match, creates the remaining categories, and marks previous dishes unavailable. It never deletes products or changes saved order line snapshots. Each write is audited and individually transactional. The whole import is not one transaction; if interrupted, re-running it resumes by category/name without duplicating products. The final catalog is checked against every imported name, price, availability flag and additional tax rate. Preview and applied reports are saved under ignored `web-data/menu-import/`.

The shared Vengara test branch is updated; independent offline desktop databases are separate. Connected desktop tables refresh within about 5 seconds and the phone menu polls within about 15 seconds while active. No mobile rebuild is needed for catalog changes. Existing phone drafts containing archived demo products should be removed before starting a new order.

## Checks

```powershell
node --test scripts/menu-import.test.cjs
```

These reconcile each PDF page's item count and sum of listed prices, verify backup creation and existing bill preservation, check repeated/interrupted imports, and reject invalid menu data before any write.
