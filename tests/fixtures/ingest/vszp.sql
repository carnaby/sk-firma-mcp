--
-- PostgreSQL database dump (syntetická vzorka pre testy)
--
SET client_encoding = 'UTF8';

COPY vszp.debtors (id, name, address, city, postal_code, amount, payer_type, published_on, created_at, updated_at, cin, health_care_claim) FROM stdin;
1	Firma Sedem s. r. o.	Vzorová 123/4	Bratislava	82101	6797.01	Zamestnávateľ	2026-07-12	2026-01-01 00:00:00	2026-07-12 04:00:00	77777777	f
2	Vzorový Ján	Ukážková 3	Nitra	94901	250.50	SZČO	2026-07-12	2026-01-01 00:00:00	2026-07-12 04:00:00	99999998	f
3	Občan Bez Ičo	Niekde 1	Trnava	91701	120.00	Samoplatiteľ	2026-07-12	2026-01-01 00:00:00	2026-07-12 04:00:00	\N	f
4	Zahraničná Entita	Somewhere 1	Wien	\N	500.00	Zamestnávateľ	2026-07-10	2026-01-01 00:00:00	2026-07-12 04:00:00	\N	f
\.

-- koniec dumpu
