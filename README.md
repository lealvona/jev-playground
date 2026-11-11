# JEV playground

A single-page playground for JEV-style decision models. You give the model a
piece of context, a question, and the answers it is allowed to choose from. The
page shows the choice it made, the relative score of every candidate, and how
those scores moved since your previous run.

The repository holds the page and a small Node.js helper that serves it. It does
not include a model or a decision service. You point the helper at one you run
yourself.

## What is in the page

Ten editable examples, each a JSON request you can change and rerun:

| Example | Kind | What it asks |
|---|---|---|
| Support routing | choice | Which team should handle a customer message |
| Intent detection | yes / no | Two separate questions about one message |
| Invoice review | choice | Apply a written approval policy |
| Agent next step | choice | Pick the next action from a described page state |
| Bug triage | choice | Route an incident report |
| Release readiness | choice | Check a release gate |
| Lead qualification | choice | Choose the next sales step |
| Proposal readiness | yes / no | Find the missing commitment |
| Sprint priority | choice | Prioritise constrained work |
| Project blocker | choice | Decide how to unblock a milestone |

Each example keeps its own edits and its last two successful responses until you
reload the page. The full API response and the exact payload that produced it
are shown under the readout. Every example is synthetic, and the page only
displays a recommendation. It never carries one out.

## Run it

You need Node.js and a decision service that speaks the contract described
below.

```bash
JEV_UPSTREAM=http://127.0.0.1:8081 node server.cjs
```

In PowerShell:

```powershell
$env:JEV_UPSTREAM = 'http://127.0.0.1:8081'
node server.cjs
```

Then open <http://127.0.0.1:9999/>. Replace the example address with the base
URL of your own decision service.

The page loads whether or not the decision service is up. While it is down the
header reads "Service unavailable" and a run returns a `jev_offline` error. Your
edits stay in the page.

The helper has no dependencies. It was tested on Node.js 24. It uses the
built-in `fetch`, which Node.js has shipped without a flag since version 18, and
`AbortSignal.timeout`.

## Configuration

The helper reads environment variables only.

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `JEV_UPSTREAM` | yes | none | Base URL of the decision service. The helper exits with an error when it is missing or is not an http(s) URL. |
| `JEV_BIND` | no | `127.0.0.1` | Address to listen on. |
| `JEV_PORT` | no | `9999` | Port to listen on. |
| `JEV_ALLOWED_HOSTS` | no | none | Extra `Host` header values to accept, comma-separated, each written as `host:port`. |

The helper accepts a request only when its `Host` header is `127.0.0.1:<port>`,
`localhost:<port>`, the bind address with the port, or a value from
`JEV_ALLOWED_HOSTS`. If you listen on `0.0.0.0` or reach the helper by a
hostname, add that name and port to `JEV_ALLOWED_HOSTS`.

## Routes

| Request | Result |
|---|---|
| `GET /` | The playground page |
| `GET /healthz` | Health of the helper itself |
| `GET /api/health`, `/health`, `/v1/version` | Forwarded to `GET <JEV_UPSTREAM>/health` |
| `POST /api/decide`, `/v1/systemone` | Forwarded to `POST <JEV_UPSTREAM>/v1/systemone` |

Request bodies are limited to 2 MiB. Before a decision is forwarded the helper
checks the service's `/health`. If that check fails it answers `503` with
`{"ready": false, "error": {"code": "jev_offline", ...}}` and does not replay
the request.

## Decision service contract

This is what the page sends and what it reads back. Your service can return
more fields. The page shows them in the raw response and ignores them
otherwise.

`GET /health` should return JSON with `ready` (boolean), `contract` and `model`
(strings shown in the header).

`POST /v1/systemone` receives a `state` and named `questions`. A question is
either a `choice` with described criteria or a `noul`, which is a yes/no
question:

```json
{
  "model": "openjev",
  "state": "Customer message: My card was charged twice for order 2841.",
  "questions": {
    "team": {
      "type": "choice",
      "instructions": "Which team should handle this customer request?",
      "criteria": {
        "billing": "Payments, duplicate charges, invoices and refunds",
        "shipping": "Parcel delivery, tracking and missing shipments"
      }
    },
    "refund": {
      "type": "noul",
      "instructions": "Is the customer requesting a refund?"
    }
  }
}
```

The response carries one entry in `answers` for each question key. For a choice
the page reads `probabilities`, a map from criterion key to a number between 0
and 1. For a `noul` answer it reads `type: "noul"` and a numeric `noul`, which
it shows as the yes share. The numbers below only illustrate the shape:

```json
{
  "answers": {
    "team": { "probabilities": { "billing": 0.97, "shipping": 0.03 } },
    "refund": { "type": "noul", "noul": 0.91 }
  }
}
```

On failure, return a non-2xx status with `{"error": {"message": "..."}}` and
the page shows the message.

## Check the examples

```bash
node check-examples.cjs
```

This confirms that the page's inline script parses and still defines ten
examples. To send every example through a running playground and print the
answers:

```bash
node check-examples.cjs --run http://127.0.0.1:9999
```

## Security

- There is no authentication. Anyone who can reach the helper can submit model
  requests through it. It listens on the loopback address unless you change
  `JEV_BIND`.
- The `Host` allowlist and a same-origin check on the `Origin` header stop
  other websites from calling the helper from your browser. They do not
  restrict other machines on a network you have exposed it to.
- The helper serves plain HTTP.

## Limits

- The page text and examples were written for an APUS-OpenJev 4B Q8 model
  behind a local adapter that exposes `/v1/systemone`. That adapter is not part
  of this repository. The text in the page describes that setup: text input
  only, and no ordinal scores.
- Scores are relative probabilities across the choices you supplied. They are
  not calibrated confidence and they do not show that an answer is correct.
- A model can pick a wrong winner when evidence is missing or the options are
  poor. Add a review or "insufficient evidence" choice where it fits, and keep
  exact business rules in code.

Model references linked from the page:
[APUS decision interface](https://huggingface.co/apus-ailab/APUS-OpenJev-v1) and
[OpenJev scoring mechanism](https://huggingface.co/openjev/openjev).

## License

MIT. See [LICENSE](LICENSE).
