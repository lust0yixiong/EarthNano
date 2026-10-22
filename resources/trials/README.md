# EarthNano upstream trial inputs

These cases use the existing Project → new Session → composer → Send path. Choosing a case
only stages its prompt and managed attachments. It does not execute code, approve permissions,
start optimization or overwrite an existing draft. Python and a configured model are required
to run them in the app. Model calls may incur provider fees.

- **OpenScience Case16:** original `analysis.py`, frozen `registry_source.json` and the two
  reference CSVs from the paper's public validation dataset, pinned to
  `5a775981cc7142651116960b0b96501088670c98`. Only script and input are attached; reference
  results remain separate from execution inputs. The original data is public registry data.
- **Harness² ledger:** both exact original `DemoAdapter` inputs from the pinned upstream
  `harness2/demo.py`. The desktop prompt uses the original Notebook/artifact interfaces;
  optimization is explicitly started through the existing shared execution core. The
  standalone deterministic demo remains unchanged under `vendor/harness2`.

Each directory records source, license and input hashes in `SOURCE.json`. Upstream files and
licenses are preserved. Prompt files are EarthNano instructions for the existing tools, not
claims that upstream provides these exact desktop prompts. The prompts are supplied in English
as reproducible task material; the example picker uses the application's translated UI.

Run the fixed-input/reference checks and both original recursion modes with Python 3.12:

```bash
python3 scripts/earthnano/verify-upstream-trials.py --output /tmp/earthnano-trials-new-run
```

The destination must not already exist. The script writes a separate report and rerun files.
This is an offline calculation/algorithm check. Packaged desktop and live-model evidence must
be recorded separately; none of these checks alone establish general scientific correctness.
