I want to make a Retrieval-Augmented Generation server and vector database to ingest EDI 837 claims and parse them to export a static HTML file with REACT baked into it to display the claim and it's contents.

This should be written in typescript.

When the server gets a claim, it should read it, extract the fields, and then create and export an HTML file with a complete REACT bundle to display the claim in a human readable format.

When a human opens the static webpage, it should have a maximum content width of 1200px, with two sub sections.
One section should display the electronic claim, and the other section should display form fields with each individual data type as the field name, and the individual data as the field value.
When someone hovers over a field value or name, it should highlight where in the electronic claim that data came from.

When you are finished you should generate a readme explaining the project with an example of what the page looks like and a references section of all external references you accessed

follow up prompts:
- explain the HIPAA problems with the project and how you could address them
- explain how to make the application production ready
- add a new method to retreive the raw claim
- generate an open api spec
- add a new method to generate a claim summary, make it hipaa compliant
- future proofing: add a tie in for the ingestion where a call can be made to an AI endpoint in case a claim field is unrecogonized so that the AI can go grab the x12 definitions for missing claim fields and add them to the knowledge base