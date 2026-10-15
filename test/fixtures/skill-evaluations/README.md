# Provider skill evaluation briefs

`cases.json` holds twelve synthetic product briefs (S-T01 to S-T12) and the
behavior the packaged `daski-provider` skill should produce for each. Every
product, endpoint and identifier is invented; `.example` hosts never
resolve. Nothing here describes a real supplier.

## Running an evaluation

1. Install the packaged skill from the revision under test into a clean
   agent session:

   ```bash
   npx skills add https://github.com/daski-io/provider --skill daski-provider
   ```

2. Give the agent one case's `brief`, with a checkout of this repository at
   the revision under test (`checkout: "current"`) or, for S-T07, at a
   pre-external-job revision (package version 0.1.0). Tell it not to call any
   live product, sign, spend, register or push.
3. Record the agent's selected path, its stated supporting facts, its plan
   and, where the case has one, its adapter outline: not only whether a
   keyword appears.
4. Compare with `expected`: `selection` is the decision; every `mustState`
   point must be stated in substance, `plan` and `adapterOutline` describe a
   correct implementation, and no `mustNot` behavior may occur.

`npm run test:run -- test/skillEvaluations.test.ts` checks that the cases are
well formed, use only synthetic endpoints and name only adapter members the
checked-out source declares, and verifies S-T12's automated part (one
package, matching versions, the entrypoint's line cap). It does not run an
agent.

Passing these cases shows the intended routing behavior. It does not
establish any real product's undocumented payment or recovery guarantees.
