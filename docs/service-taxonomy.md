# Service taxonomy

Daski discovery uses three separate dimensions:

- `categoryFamily`: broad marketplace placement;
- `serviceType`: a controlled, specific product type coordinated with Daski;
- `jurisdictions`: where the offering can be fulfilled.

Do not encode one dimension into another.

## Category families

The provider contract currently accepts:

| Family | Typical scope |
| --- | --- |
| `business-formation` | Company creation and corporate lifecycle |
| `legal-ip` | Legal and intellectual-property services |
| `compliance` | Screening, reporting, audit, and regulatory work |
| `finance` | Accounting, tax, treasury, insurance, and payments support |
| `domains-web` | Web presence, hosting, certificates, and naming |
| `communications` | Email, phone, messaging, and communication channels |
| `compute-ai` | Compute, models, inference, and automation |
| `data` | Data acquisition, enrichment, transformation, and analysis |
| `software-dev` | Software development, testing, and maintenance |
| `design-creative` | Design, media, and creative production |
| `marketing-growth` | Marketing, advertising, audience, and growth |
| `sales-support` | Sales operations and customer support |
| `human-talent` | Recruiting, staffing, training, and expert labor |
| `operations-admin` | Back-office and administrative operations |
| `logistics-physical` | Shipping, warehousing, field, and physical services |
| `other` | Offerings that do not fit an approved family |

Choose the narrowest accurate family. Do not add a new literal only in your
fork; it will not be understood by marketplace discovery.

The dummy service uses `other` because it is a reference, not a real
marketplace product.

## Service type

`serviceType` is a lowercase kebab-case controlled value for the actual
product. It is more specific than `categoryFamily` and should remain stable
across copy edits.

Coordinate new values with Daski onboarding before launch. A locally invented
value may compile but fail marketplace review or discovery expectations.

## Jurisdictions

Use:

- `global` by itself for a genuinely location-independent offering;
- ISO 3166-1 alpha-2 country codes such as `US`; or
- ISO 3166-2 subdivision codes such as `US-CA`.

Values must be uppercase except `global`, unique, and non-empty. Do not list
`global` together with narrower jurisdictions.

Jurisdiction means where the service can actually be fulfilled under its
supplier, legal, and operational controls. It is not merely where an HTTP
request can originate.

## Fulfillment mode

Each service declares a default and each skill may override it:

- `automated`: normally completes without a person;
- `human`: a person performs the material fulfillment; or
- `hybrid`: automation and human work are both material.

This is buyer-facing planning metadata. It does not grant authority or replace
readiness.

## Human parties

`humanParties` answers whether the skill needs identifying data for a human
party of record:

- `required`;
- `varies`; or
- `none`.

Omit the field only when unspecified. It is independent of fulfillment mode:
an automated product can still require a human party, and human fulfillment
can operate without collecting a buyer's personal identity.

## Placement checklist

Before publishing a service:

1. Select one approved `categoryFamily`.
2. Coordinate one stable `serviceType` with Daski.
3. List only supported jurisdictions.
4. Set the service default and any skill-specific fulfillment modes.
5. Declare `humanParties` for every skill when known.
6. Keep taxonomy, manifest, skill docs, signed listing artifacts, and tests in
   agreement.
