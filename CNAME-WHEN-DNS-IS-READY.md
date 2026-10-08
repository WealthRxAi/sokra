# Putting getsokra.com live

`docs/CNAME` was removed on 2026-10-08 and must go back once DNS is pointing at
GitHub. Here is why, and the order that works.

GitHub Pages reads the custom domain from `docs/CNAME`. The moment that file
exists, Pages **301-redirects** `wealthrxai.github.io/sokra/*` to that domain.
It does this whether or not the domain resolves to GitHub yet. getsokra.com was
still on Squarespace's parking page, so adding the file took the live app down
at both addresses at once.

So the order matters, and it is the opposite of what it looks like:

1. **DNS first.** At the registrar, on getsokra.com, remove the parking records
   and add four A records on `@` pointing at `185.199.108.153`,
   `185.199.109.153`, `185.199.110.153` and `185.199.111.153`, plus a CNAME on
   `www` pointing at `wealthrxai.github.io`.
2. **Wait for it to resolve.** `dig +short getsokra.com` should return the four
   GitHub addresses and nothing from Squarespace.
3. **Then** restore the file: `printf 'getsokra.com\n' > docs/CNAME`, commit and
   push. Pages picks the domain up from it; the repo settings field is written
   from this file, not the other way round.
4. In the repo's Pages settings, tick **Enforce HTTPS** once the certificate has
   been issued. That can take up to an hour and the box stays greyed out until
   it is ready.
5. Point the app back at the new domain so Stripe returns customers to a live
   page:

   ```sql
   insert into sokra.config(key, value) values ('app_url', 'https://getsokra.com')
   on conflict (key) do update set value = excluded.value, updated_at = now();
   ```

   Until step 5, `app_url` stays `https://wealthrxai.github.io/sokra`, which is
   where the app actually answers.
