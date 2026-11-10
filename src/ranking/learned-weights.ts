// Written by `npm run learn -- train` on 2026-11-10, fitted on every site. Do not edit by hand:
// change the data or the features and train again. Evaluation: eval/results-learned.md.
import type { LearnedModel } from "./learned.js";

export const LEARNED_MODEL: LearnedModel = {
  version: "learned-1",
  trainedAt: "2026-11-10",
  trainedOn: {
    sites: 22,
    links: 5402,
    positives: 1453,
    labeler: "gpt-4.1-mini, prompt labels-2"
  },
  bias: -3.094,
  weights: {
    anchor_full_name: 2.971,
    anchor_term: 1.777,
    anchor_clean_name: 1.112,
    anchor_extra_words: -1.561,
    url_term: -0.632,
    heading_term: 0.05,
    context_term: 0.027,
    only_nearby_text: -0.341,
    year_only_anchor: 4.401,
    host_term: -0.847,
    contact_group: 0.225,
    document_file: 0.315,
    file_for_contact: -2.495,
    own_site_page_for_document: -2.292,
    other_platform_page_for_document: -0.743,
    parent_path_score: 0.786,
    in_menu: -0.6,
    supporting_paper: -3.872,
    other_government_site: -2.286,
    has_year: 2.385,
    no_link_text: 0.068,
    long_link_text: -0.812
  }
};
