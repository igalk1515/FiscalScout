# Learned ranker · evaluation

5402 labeled links from 22 sites, 1453 of them targets. Each site is scored by a model fitted on the other 21 sites only. The reference is the LLM's label of every link. Precision@10 counts labeled targets among the ten best-scored documents of the site; ties in the rules score are broken by fiscal year, as in the API.

| Site | Links | Targets | AUC rules | AUC learned | P@10 documents, rules | P@10 documents, learned |
|---|---|---|---|---|---|---|
| a2gov.org | 408 | 79 | 0.88 | 0.99 | 9/10 | 10/10 |
| asu.edu | 90 | 15 | 0.75 | 0.83 | 4/10 | 7/10 |
| austinisd.org | 199 | 27 | 0.91 | 0.97 | 3/10 | 8/10 |
| austintexas.gov | 341 | 72 | 0.82 | 0.84 | 10/10 | 10/10 |
| boerneisd.net | 35 | 12 | 1.00 | 1.00 | 10/10 | 10/10 |
| boisestate.edu | 71 | 3 | 0.90 | 0.99 | 0/0 | 0/0 |
| bouldercolorado.gov | 29 | 2 | 0.63 | 0.91 | 0/0 | 0/0 |
| bozeman.net | 46 | 25 | 0.95 | 0.99 | 10/10 | 10/10 |
| bvsd.org | 162 | 112 | 0.78 | 0.80 | 6/10 | 9/10 |
| cityofmadison.com | 320 | 71 | 0.92 | 0.88 | 4/10 | 6/10 |
| cityofpaloalto.org | 861 | 77 | 0.95 | 0.98 | 8/10 | 9/10 |
| colorado.edu | 157 | 0 | - | - | 0/1 | 0/1 |
| danecounty.gov | 848 | 503 | 0.37 | 0.39 | 4/10 | 4/10 |
| fcgov.com | 143 | 8 | 0.89 | 0.97 | 5/9 | 5/9 |
| lwsd.org | 161 | 58 | 0.62 | 0.82 | 8/10 | 9/10 |
| raleighnc.gov | 116 | 42 | 0.84 | 0.86 | 9/10 | 7/10 |
| roundrockisd.org | 2 | 0 | - | - | 0/0 | 0/0 |
| santamonica.gov | 31 | 0 | - | - | 0/0 | 0/0 |
| tempe.gov | 118 | 88 | 0.48 | 0.74 | 10/10 | 10/10 |
| traviscountytx.gov | 392 | 69 | 0.84 | 0.80 | 9/10 | 6/10 |
| unm.edu | 191 | 34 | 0.57 | 0.83 | 1/10 | 2/10 |
| washoecounty.gov | 681 | 156 | 0.73 | 0.84 | 8/10 | 10/10 |

**All sites:** AUC rules 0.762, learned 0.833. Precision@10 on documents, summed over sites: rules 118/170, learned 132/170.

## Weights of the final model (fitted on every site)

Log-odds per unit of each feature. Keyword features are multiplied by the keyword group's weight.

| Feature | Weight |
|---|---|
| (bias) | -3.09 |
| year_only_anchor | 4.40 |
| anchor_full_name | 2.97 |
| has_year | 2.38 |
| anchor_term | 1.78 |
| anchor_clean_name | 1.11 |
| parent_path_score | 0.79 |
| document_file | 0.32 |
| contact_group | 0.23 |
| no_link_text | 0.07 |
| heading_term | 0.05 |
| context_term | 0.03 |
| only_nearby_text | -0.34 |
| in_menu | -0.60 |
| url_term | -0.63 |
| other_platform_page_for_document | -0.74 |
| long_link_text | -0.81 |
| host_term | -0.85 |
| anchor_extra_words | -1.56 |
| other_government_site | -2.29 |
| own_site_page_for_document | -2.29 |
| file_for_contact | -2.50 |
| supporting_paper | -3.87 |
