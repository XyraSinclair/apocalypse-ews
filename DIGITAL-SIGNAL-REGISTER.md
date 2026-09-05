# Warning.watch: digital-signal collection register

**Planning revision · 5 September 2026 · No current threat assessment**

This is the collection side of the early-warning system: **12 watch families, 64 candidate observable changes, and 26 named source surfaces**. It is not 64 validated predictors or 26 integrations. Aircraft, public posts, official decisions, infrastructure observations, and environmental measurements belong in the same persistent watch, with different roles and evidential weight.

The families organize work; they do **not** certify independence. A GNSS map derived from ADS-B is not a second aircraft-independent instrument. Two institutions can respond to the same order. Physical sensors can independently corroborate the same event without independently establishing its cause or intent.

**Role tags:** B = baseline/context; C = possible crisis precursor; E = event/consequence verification; D = disconfirmation/recovery; H = observation health. Every candidate should be examined in both directions when the source permits. A normal post-event radiation reading cannot disconfirm preparations for future use.

**Source status:** S = bounded response fetched and inspected this session; D = provider documentation inspected, operational access not exercised; R = public landing/reference found but operational contract unresolved; I = existing project instrument, not revalidated this session. Documentation is not a service-level guarantee. The source table below records access separately from these research states.

## 1. The 64-observable watch roster

### A. Aircraft activity — standing physical-observation family

Keep the existing aggregate aviation instrument. New observables are proposals; the current half-hour archive does not silently acquire live track, mission, payload, or passenger knowledge. Source R01; aviation safety and service context R02–R03.

| ID | Observable change | Agent's next question | Main rival / limit | Role |
|---|---|---|---|---|
| A01 | Aggregate airborne counts change across existing cohorts | Real activity, changed visibility, or changed classification? Compare matched routine periods. | Receiver loss, metadata drift, holidays | B/C/H |
| A02 | Aggregate departure activity rises or becomes unusually synchronized | Does the change persist beyond the usual operating schedule? | Ordinary business cycle, weather recovery, exercise | B/C |
| A03 | An aviation anomaly persists across successive source observations | Is this one sustained episode or repeated counting of stale observations? | Archive duplication, delayed updates | C/H |
| A04 | Civil flights divert or avoid a broad region | What regulator, carrier, weather, or service event explains the change? | Weather and commercial disruption | C/E |
| A05 | Multiple civil airports show unusual outbound-versus-inbound imbalance | Are arrivals suppressed, departures increased, or both? | Cancellation schedules, asymmetric coverage | C |
| A06 | Previously abnormal aviation activity returns toward its matched baseline | Is the underlying disruption resolving, or did observation coverage deteriorate? | Lost feeds can imitate normalization | D/H |

Do not turn this into tracking individual families, identifying sensitive missions, or publishing tactical military locations. Government and aircraft-class aggregates are not passenger identities or attack orders.

### B. Aviation and maritime hazard declarations — operational notices

Official notices are unusually useful because they describe actions with effective times, scope, amendments, and cancellations. They are not automatically nuclear-specific. Sources R02–R04, R26.

| ID | Observable change | Agent's next question | Main rival / limit | Role |
|---|---|---|---|---|
| B01 | A conflict-zone aviation bulletin is issued or materially strengthened | What exact instruction changed, for which operators, effective when? | Conventional air-defense risk | C |
| B02 | Public airspace restrictions appear outside the routine calendar | What stated civil hazard or announced activity explains them? | Exercise, launch safety, wildfire | B/C |
| B03 | A restriction is extended, broadened, or canceled early | Is there a revised official explanation or ordinary operational delay? | Weather, administrative correction | C/D |
| B04 | Maritime safety authorities issue unusual restrictions or port-approach warnings | Is the hazard new and relevant to civilian routes? | Wrecks, storms, maintenance | C/E |
| B05 | Air and maritime notices change during the same episode | Are they two outputs of one announced activity or evidence of wider disruption? | Shared issuing order; not two intent votes | C |
| B06 | Navigation restrictions are withdrawn and normal access is explicitly restored | Did actual civil service resume, or only the notice expire? | Automatic expiry, incomplete restoration | D |

### C. Civil shipping, transport, and commercial operating decisions

Sources R03–R05; carrier, port, rail, and border authority notices need jurisdiction-specific enrollment. AIS access is not assumed free or complete.

| ID | Observable change | Agent's next question | Main rival / limit | Role |
|---|---|---|---|---|
| C01 | Aggregate civil shipping routes or port-call activity change | Do weather, port notices, labor action, or announced restrictions explain it? | Commercial cycles, receiver coverage | B/C |
| C02 | Port queues, ferry operations, or canal throughput change sharply | Is this capacity loss, deliberate service reduction, or normal congestion? | Accident, drought, scheduling | C/E |
| C03 | Several carriers suspend service to the same region | Separate independent company decisions from compliance with one regulator. | Common order, insurance restriction | C |
| C04 | Public rail, border, or road authorities report unusual closures or capacity changes | Which civilian options are becoming unavailable, and for how long? | Holiday traffic, accident, industrial action | C/E |
| C05 | Carriers, ports, or borders announce and implement service restoration | Is restoration broad, partial, temporary, or only promised? | Marketing announcement without operation | D |

### D. Public administrative acts and institutional preparation

Sources R06–R07; original national/local gazettes and institutional pages are enrollment work, not universal feeds. Distinguish a legal or administrative act from a speech about one.

| ID | Observable change | Agent's next question | Main rival / limit | Role |
|---|---|---|---|---|
| D01 | Travel advice changes in substance | New threat assessment, geographic change, or editorial refresh? | Weather, disease, ordinary legal update | B/C |
| D02 | An embassy authorizes or orders departure, or suspends services | Mandatory or optional; new or recycled; specified reason and scope? | Conventional conflict, unrest, staffing | C |
| D03 | Civil-protection guidance changes or a new preparedness campaign starts | Routine campaign, targeted precaution, or actual emergency instruction? | Annual preparedness calendar | B/C/E |
| D04 | Public institutions announce exceptional staffing or continuity arrangements | What implemented change and stated contingency are documented? | Exercise, disaster preparation | C |
| D05 | Published procurement for shelters, emergency communications, or medical readiness changes | New program or old award; extraordinary quantity or routine replacement? | Fiscal cycle, pandemic, publication lag | B/C |
| D06 | Emergency legal powers, requisitions, or unusual administrative restrictions are enacted or rescinded | What practical authority changed, effective when, and was it used? | Domestic politics, nonnuclear emergency | C/D |

### E. Official statements, diplomacy, and the routine calendar

Original ministry, government, international-body and state-media publications; R06/R08/R12 can provide discovery, not replacement for the original. A first source list must include relevant national languages, not only English translations.

| ID | Observable change | Agent's next question | Main rival / limit | Role |
|---|---|---|---|---|
| E01 | Nuclear-related language becomes more specific about conditions or consequences | Exact original wording, authorized speaker, new statement or reused quotation? | Signaling, translation error | B/C |
| E02 | An official readiness or posture change is announced | What was actually ordered or acknowledged, rather than inferred by reporters? | Defensive precaution; announcement is not implementation | C |
| E03 | An exercise or test schedule is announced, revised, or concluded | Which observed changes does the known schedule explain? | Incomplete announcements; exercises can interact with crises | B/C/D |
| E04 | Emergency diplomacy or an extraordinary institutional session is announced | New decision, clarification attempt, or reaction to existing public news? | Ceremonial or routine meeting | C/D |
| E05 | A crisis communication arrangement is specifically suspended or restored | Is the channel itself affected, rather than a public meeting or website? | Private channels may remain open | C/D |
| E06 | A threat is withdrawn, a claim corrected, or restraint is announced and verified | Which incident assumptions must change, and what implementation remains uncertain? | Words without implementation | D |

### F. Official warning emissions and protective instructions

Sources R13–R14, plus jurisdiction-specific official services. NWS access does not establish comprehensive IPAWS coverage. This family has a prevalidated emergency relay route; it does not wait for a model to infer nuclear intent.

| ID | Observable change | Agent's next question | Main rival / limit | Role |
|---|---|---|---|---|
| F01 | A relevant official alert is issued | Authentic issuer, actual versus test, applicable geography and validity? | Drill, replayed message, wrong jurisdiction | E |
| F02 | An alert changes instructions, severity, area, or expiry | What exactly supersedes the previous message? | Duplicate delivery is not a new emergency | E/D |
| F03 | An authority cancels an alert or publishes a correction | Has the correction reached every dependent view and notification? | A cancellation may not mean every hazard ended | D |
| F04 | Public alert-test schedules change or an off-calendar test is announced | Is there authoritative evidence of a test and its reason? | Routine systems maintenance | B/C |
| F05 | Shelter, evacuation, or emergency service instructions are published locally | Preserve the authority's exact action and area; do not invent broader advice. | Different hazards require different instructions | E |

### G. Public posts, eyewitness material, local reporting, and news indexes

Sources R08–R12. Public X/Twitter posts are a first-class discovery stream, subject to actual account access. Local reporting and public specialist communities can expose events before national headlines; that is a hypothesis to measure, not an assumed latency advantage. No private-person dossiers.

| ID | Observable change | Agent's next question | Main rival / limit | Role |
|---|---|---|---|---|
| G01 | A public post makes a concrete claim about a civilian hazard or institutional change | Locate the original claim, claimed time, supporting material, and relevant authority. | Anonymous rumor can cue investigation, not certify a fact | C/E |
| G02 | Multiple local reports describe apparently related observations | Are these distinct witnesses, copies, or observations of different events? | Viral duplication, incorrect place names | C/E |
| G03 | Images, video, or audio are presented as new evidence | Is the original material current and contextually consistent; has it appeared before? | Recycled media, edits, synthetic content | C/E/H |
| G04 | Multilingual local news produces a new event cluster | What happened beyond a keyword count, and which source originated it? | Syndication, NLP category error | B/C/E |
| G05 | A claim spreads rapidly across platforms or languages | What caused attention to spread; which reports are descendants rather than new observations? | One public shock can move many channels | B/H |
| G06 | Original posts, reports, or images are corrected, deleted, or refuted | Which dependent claims should be withdrawn or marked unsupported? | Deletion alone does not establish concealment or falsity | D/H |

### H. Civilian service operation and connectivity

Sources R20–R23; public operator status pages need enrollment. This family establishes disruption and observation limits, not attack attribution. Do not label an outage EMP, sabotage, or a military action from its shape alone.

| ID | Observable change | Agent's next question | Main rival / limit | Role |
|---|---|---|---|---|
| H01 | Regional connectivity observatories report degradation | Do independent operator statements or other observation methods agree? | Maintenance, weather, service policy | E/H |
| H02 | Several public telecom/cloud/operator status pages change | Shared supplier incident or genuinely distinct service failures? | Common cloud dependency | E/H |
| H03 | Aggregate public navigation-accuracy maps change | Changed accuracy, changed traffic sample, or changed data coverage? | ADS-B-derived; often daily, not independent live sensing | B/C/H |
| H04 | Public power-system data or utility notices show unusual disruption | What outage, demand, or operational explanation is actually supported? | Weather, industrial schedule, reporting revision | E |
| H05 | Payment, transport, or public-service operators report regional interruption | What practical civilian consequences are documented? | IT incident; no automatic nuclear implication | E |
| H06 | Connectivity, power, or service is restored | Independent restoration evidence or only the monitoring site recovering? | Partial restoration, stale status | D/H |

### I. Radiation and geophysical measurements

Sources R15, R17–R18; CTBTO public findings are distinct from restricted monitoring products. These are principally consequence verification and scientific context, not forecasts of intent.

| ID | Observable change | Agent's next question | Main rival / limit | Role |
|---|---|---|---|---|
| I01 | A public radiation monitor departs from its normal range | Units, calibration, precipitation, station quality, neighboring coverage? | Natural variation, instrument fault | E/H |
| I02 | Several genuinely separate radiation instruments show a coherent change | Do time, measurement type, coverage and official interpretation support one event? | Shared equipment/processing artifacts | E |
| I03 | A public seismic catalog reports a significant new event | What is the agency's actual classification and uncertainty? | Earthquake, industrial blast; absence does not exclude an airburst | E |
| I04 | Scientific agencies revise event classification or publish radionuclide findings | What new evidence supports attribution, and how delayed is it? | Preliminary classification is not final nuclear confirmation | E/D |
| I05 | Authorities explain an anomaly or relevant measured levels return toward baseline | Which specific hazard hypothesis is weakened, within the monitored area and time? | Normal readings outside the affected area prove little | D |

### J. Satellite environmental observations and public imagery analysis

Source R19; other optical, nightlight, radar and commercial imagery products are candidate enrollment work. No live sensitive-site targeting or vulnerability mapping. Favor broad civilian consequences and qualified published analysis.

| ID | Observable change | Agent's next question | Main rival / limit | Role |
|---|---|---|---|---|
| J01 | Thermal observations indicate unusual fire activity | Is it new, within a sensor swath, and unexplained by ordinary fires or industry? | Wildfires, agricultural burning; hotspot is not detonation | E |
| J02 | Broad smoke or environmental imagery supports a reported civilian event | Does observation time and actual coverage match the claim? | Clouds, unrelated smoke, acquisition delay | E |
| J03 | Broad nightlight or civilian land-surface changes are reported | Is the comparison seasonally and instrumentally comparable? | Clouds, moonlight, compositing, routine development | B/E |
| J04 | A qualified public imagery analysis is published or corrected | What source acquisition and method underlie the interpretation? | Several analysts may use the same image | C/E/D |

### K. Public attention, market prices, and commercial risk assessment

Sources R24–R25, plus explicitly licensed/public market and industry notices. Useful as attention, common-cause, and comparator streams; not independent confirmation of nuclear preparations.

| ID | Observable change | Agent's next question | Main rival / limit | Role |
|---|---|---|---|---|
| K01 | A relevant forecast or prediction-market contract changes sharply | What exact resolution rule, liquidity, spread, and public news explain the move? | Thin market, manipulation, ambiguous contract | B/C |
| K02 | Public war-risk insurance or freight terms change | New institutional decision or secondhand report; which routes and contingencies? | Conventional disruption; much pricing is not public | B/C |
| K03 | Public outbound travel pricing or availability changes | Real capacity reduction, normal demand, or an availability artifact? | Holidays, dynamic pricing, incomplete inventory | B/C |
| K04 | Public search-interest measures change | What is the sampling, normalization, time lag, and plausible media cause? | Attention to a rumor is not a precursor | B/H |
| K05 | Attention and prices diverge from independently verified events | Is a serious development being missed, or did a rumor outrun reality? | Neither popular panic nor calm settles the event | B/D |

### L. Confounders, routine behavior, and observation health

Sources R01–R03/R16/R19–R23 and the source registry itself. This is a mandatory cross-cutting watch, not a twelfth threat vote.

| ID | Observable change | Agent's next question | Main rival / limit | Role |
|---|---|---|---|---|
| L01 | Weather, space weather, exercises, holidays, or maintenance coincide with an anomaly | Does the timing and affected geography actually fit, rather than merely offer a convenient story? | A confound's existence does not prove it caused everything | B/D |
| L02 | A source loses coverage, stops updating, changes schema, or revises history | Which apparent world changes are now measurement artifacts? | Never convert missing observations into safety | H |
| L03 | An incident's sources collapse to one origin or shared sensor | What remains independently established after deduplication? | Model agreement adds no measurements | H |
| L04 | Newly enrolled sources or changed languages/coverage alter event volume | Did the world change or did our ability to see it change? | Apparent escalation after expanding collection | H |

## 2. Concrete source and access register

Read or sampled on 5 September 2026. **Cadence is not event-to-publication delay.** Where a precise delay is not documented or measured, it remains unknown. No account was created, access grant requested, purchase made, or source integrated by this audit.

| ID | Source surface and full URL | Research / access | Timing and coverage actually supported | Initial watch role |
|---|---|---|---|---|
| R01 | Existing project ADS-B archive instrument; public product https://warning.watch | I; existing operating path documented in the repository | Current source observations are half-hour slots; a two-minute refresh is not two-minute physical observation. Coverage and cohort limits remain. | Standing aggregate aircraft watch; retain existing behavior until reviewed migration |
| R02 | EASA conflict-zone bulletins https://www.easa.europa.eu/en/domains/air-operations/czibs/feed.xml | S; public RSS fetched | 33 items in sample, not asserted to be 33 active restrictions. Publication/change-driven; no measured decision-to-public delay. | Standing notice and amendment watch |
| R03 | FAA NAS status https://nasstatus.faa.gov/api/airport-status-information | S; public response fetched | XML, not the JSON assumed in an initial research proposal. U.S. NAS status; no verified update SLA. | Standing civil aviation disruption and confound watch |
| R04 | IHO navigation-warning roster https://iho.int/navigation-warnings-on-the-web | D; public directory | 21 NAVAREAs. IHO explicitly says not all coordinators publish on the web and web notices are not necessarily continuously updated or correctness-monitored. | Enroll coordinator sources individually; do not claim worldwide live coverage |
| R05 | AISHub https://www.aishub.net/api | D; membership/username required | XML/JSON/CSV; provider says no more than one request per minute. Global completeness and our entitlement not established. | Candidate aggregate civil maritime watch after access audit |
| R06 | GOV.UK foreign-travel advice https://www.gov.uk/api/content/foreign-travel-advice/canada | S; public JSON fetched | `details.change_description`, `details.change_history`, `public_updated_at`; 125 history entries in sample. Public timestamp is not internal decision time. | Standing semantic-diff watch; expand country roster and other foreign ministries |
| R07 | TED public procurement https://docs.ted.europa.eu/api/latest/index.html | D; published-notice search/retrieval permits anonymous access | Publication-cycle data, not evidence of when procurement was privately decided. European public notices; unpublished notices out of scope. | Slow institutional-preparation baseline |
| R08 | GDELT 2 manifest https://data.gdeltproject.org/gdeltv2/lastupdate.txt and documentation https://blog.gdeltproject.org/gdelt-2-0-our-global-world-in-realtime/ | S; public three-product manifest fetched | Event, mentions, GKG manifest entries; documented 15-minute updates. This is not a guarantee of global reporting completeness or first-public latency. | Multilingual event discovery, origin tracing, attention baseline |
| R09 | Bluesky Jetstream https://bsky.network/docs/jetstream/ | D; current live-tail docs say no authentication | Current docs recommend v2 and describe filtering, live/replay, and create/update/delete records. Stream not sampled; delay not measured. | Filtered public-post discovery and correction tracking |
| R10 | X API https://docs.x.com/x-api/introduction | D; developer credentials and pay-per-use access | Public-post search and filtered streaming documented; our integration entitlement and cost not audited. Scry's vetted X service is another possible authorized route, not assumed access here. | High-priority public-post discovery subject to existing authorized access |
| R11 | Mastodon https://docs.joinmastodon.org/methods/streaming/ | D; public timeline streaming requires a user token in current docs | Instance-known public posts, not a global complete feed; update/delete/edit events documented. | Additional public communities with explicit instance coverage |
| R12 | ReliefWeb https://apidoc.reliefweb.int/ | D; read API requires pre-approved `appname` from November 2025 | Curated humanitarian reports; documented quota, source attribution, no accuracy guarantee. Not an unconditionally anonymous integration. | Humanitarian context and authoritative-source discovery |
| R13 | NWS alerts https://api.weather.gov/alerts?limit=2 and docs https://www.weather.gov/documentation/services-web-api | S; two alert features fetched | Public API; application User-Agent required by docs. Validity, affected areas and references present. NWS coverage is not the entire IPAWS system. | Weather/confound watch; only validated supported alert types enter an official relay |
| R14 | FEMA IPAWS https://www.fema.gov/emergency-managers/practitioners/integrated-public-alert-warning-system | D; official warning framework verified; private application feed access unresolved | Authority, jurisdiction, actual/test/update/cancel semantics need explicit integration review. No comprehensive feed claim. | Separate fast official-warning route once access and scope are validated |
| R15 | USGS GeoJSON https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php and sample https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson | S; six event features fetched | Summary feeds document one-minute updates. Agency detection/review delays are separate; a seismic event is not automatically an explosion or nuclear event. | Event verification and corrections |
| R16 | NOAA SWPC https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json and products https://www.swpc.noaa.gov/products-and-data | S; 63 records fetched | Sample is timestamped Kp records with station count. Do not infer an undocumented update SLA from one response. | Standing space-weather context, not an EMP detector |
| R17 | EPA RadNet https://www.epa.gov/radnet/learn-about-radnet | D; public dashboard and CSV links documented | Continuous gamma monitoring differs from laboratory filter/water/precipitation analysis. Provider describes near-real-time gamma; end-to-end delay not measured here. | Consequence verification with station quality and official interpretation |
| R18 | EURDEP https://remon.jrc.ec.europa.eu/About/Rad-Data-Exchange | D; public maps documented, automated access unresolved | Hourly gamma averages, up to 35 days on the public map; countries may delay public display. EURDEP explicitly is not a rapid alert system. | Regional radiation context/corroboration, not instant warning |
| R19 | NASA FIRMS https://www.earthdata.nasa.gov/data/tools/firms and API https://firms.modaps.eosdis.nasa.gov/api/ | D; public products, API MAP_KEY setup documented | Thermal/fire products with acquisition, swath, missing-data and publication constraints; no universal real-time detonation detection claim. | Broad civilian event corroboration and fire confounders |
| R20 | GPSJAM https://gpsjam.org/faq | D; public daily map | Aggregates aircraft-reported navigation accuracy over 24 hours; updates daily. Derived from airplanes.live/ADS-B Exchange, not an independent or minute-level instrument. | Context and navigation-disruption investigation |
| R21 | Cloudflare Radar https://developers.cloudflare.com/radar/get-started/first-request/ | D; Radar Read API token required | Provider supports traffic queries and aggregation metadata; no verified universal 15–45 minute outage-publication SLA. | Regional connectivity context after access audit |
| R22 | IODA https://ioda.inetintel.cc.gatech.edu/ | R; public application identified | Landing page identifies outage monitoring; concrete API contract, applicable latency and coverage remain unverified by this audit. | High-priority candidate for independent civilian connectivity observation |
| R23 | EIA grid monitor https://www.eia.gov/electricity/gridmonitor/about | R; public application identified | Page alone did not establish the needed series, access contract, or delay. Do not label it a validated rapid-outage feed. | Candidate power-system context; complement with operator notices |
| R24 | Polymarket public data https://docs.polymarket.com/ | D; public market-read example documented | Read-only candidate; no trading, no assumption that price is a calibrated nuclear probability, no measured feed latency. | Attention/liquidity/common-cause context |
| R25 | Google Trends API announcement https://developers.google.com/search/blog/2025/07/trends-api | D; dated announcement describes limited alpha access | The 2025 announcement describes daily-or-coarser aggregates and data up to two days old; current entitlement and subsequent changes not audited. | Slow attention research, not an assumed immediate precursor feed |
| R26 | NGA maritime safety https://msi.nga.mil/NavWarnings | R; public application identified through official roster | JavaScript landing page did not establish a stable automated feed contract; warning availability and latency remain coordinator-specific. | Navigation-notice enrollment candidate |

### What was actually exercised

Seven bounded ordinary response shapes were fetched and parsed: EASA RSS (33 items), FAA airport-status XML (`AIRPORT_STATUS_INFORMATION`, 52 XML elements), GOV.UK advisory JSON (125 change-history entries), GDELT manifest (3 products), USGS GeoJSON (6 events), NWS GeoJSON (2 alerts), and SWPC JSON (63 records). Counts describe the captured responses, not sustained coverage or current danger. Two reader-truncated JSON previews were recovered in full before counting.

No flight positions, private identities, military deployments, or current nuclear-risk judgment were produced by these samples. Successful retrieval proves these specific surfaces answered; it does not prove continuous availability, licensing for every reuse, or useful predictive lead time.

### Verification materially changed the proposals

- FAA's sampled endpoint returned XML, not the supposed JSON interface.
- GPSJAM is daily and shares aircraft inputs; it cannot supply independent real-time corroboration of the aircraft source.
- Mastodon streaming is not universally unauthenticated; ReliefWeb now requires an approved application name.
- Jetstream's current documentation recommends v2; remembered legacy endpoints are not the contract.
- EURDEP public display can be delayed; NWS is not a synonym for comprehensive IPAWS access.
- Unverified precise latency claims from initial research drafts were removed. A provider's update cadence, a source timestamp, and measured event-to-publication delay are three different quantities.

## 3. First collection tranche and continuing discovery

**Start the eventual implementation with breadth, not 64 bespoke detectors:** the existing aircraft instrument; EASA and FAA changes; government advisory/document changes; GDELT and an authorized public-post stream; NWS plus weather/space-weather context; USGS; and a source-health watch. Enroll radiation, maritime, connectivity, procurement, and additional regional/language sources alongside these as their actual access contracts are resolved. Existing authorized X access is worth auditing early; a missing entitlement is a gap, not a reason to pretend another platform replaces it.

For every surface, track **access → observation → interpretation → influence** separately. A lawful, affordable source can begin passive observation before its anomaly baseline is mature. This does not grant it authority to raise a public danger level. Authentic new emergency instructions are not held for a seasonal baseline.

The discovery agents must rotate through the following roster rather than repeatedly rediscovering English-language news:

| Coverage axis | Values to enumerate and track |
|---|---|
| Mechanism | Aircraft; hazard declarations; civil transport; administrative acts; official narrative; warning emissions; public reporting; service telemetry; radiation/geophysics; imagery; attention/pricing; confound/health |
| Temporal role | Baseline; crisis precursor; event/consequence; counterevidence/recovery |
| Theater | US/NATO–Russia; US–China; India–Pakistan; Korean Peninsula; Israel/regional escalation; global civilian consequence coverage |
| Publisher class | Original authority; physical provider; operator; local reporter; public community; aggregator; specialist interpreter |
| Source lifecycle | Candidate; contract checked; sampled; enrolled; healthy/degraded; retired |

**Actual coverage of this planning pass:** Fable and Kimi supplied independent designs; three source audits covered movement/environment, public information, and civilian infrastructure; Main checked primary contracts and seven response shapes. The 64 observables are a deduplicated design inventory, not independent model shots per matrix cell. The source audit was predominantly English-language documentation. All national authorities, languages, local transport operators, and NAVAREA websites were not individually audited. No claim of global saturation is made.

**Open source-discovery assignments:** enumerate each relevant national authority and public-language venue; complete the 21-NAVAREA access table; verify public-post entitlements; separate public imagery metadata from costly imagery availability; assess official alert coverage by jurisdiction; examine licensed AIS and civilian power data; find genuinely new observation mechanisms missing from these twelve families. Close a discovery ticket only with a usable source contract, a concrete unavailable-access finding, or documented duplicate mechanism—not “enough links.”

## 4. How signals should earn influence

1. **Observe:** retain useful permitted evidence and metadata with explicit retention limits. Do not archive the entire social web by default.
2. **Characterize:** estimate source-specific coverage, delay, correction rate, routine cadence, missingness and ordinary confounds. Keep frozen reference periods beside adaptive baselines.
3. **Investigate:** a real change can open an internal incident thread, with immature-baseline status visible. Repeated copies do not multiply urgency.
4. **Compare:** measure whether the source contributed a new fact, an earlier useful question, a correction, or a resolved alternative beyond ordinary headlines.
5. **Promote or demote:** stronger influence requires evidence of useful behavior across routine periods, crises and false scares. Do not choose an arbitrary universal eight-week or twelve-month silence period.

Source discovery is continuous; operational influence is governed. That is how exhaustive curiosity and a serious warning product coexist.
