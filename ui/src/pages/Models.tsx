import { Link } from '@tanstack/react-router';
import {
	Activity,
	FileText,
	GitBranch,
	Pencil,
	Play,
	Plus,
	ShieldCheck,
	SlidersHorizontal,
	Trash2
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import {
	type Control,
	Controller,
	useController,
	useFieldArray,
	useForm,
	useWatch
} from 'react-hook-form';

import { CatalogModelSelector } from '@/components/CatalogModelSelector';
import { ConfigDiffSaveActions } from '@/components/ConfigDiffDrawer';
import { LostFieldsWarning, UnsupportedInForm, useMergedEdits } from '@/components/EditorContracts';
import { MiniMonacoEditor } from '@/components/MiniMonacoEditor';
import {
	ConfirmDialog,
	Drawer,
	Dropdown,
	EmptyState,
	Field,
	FieldGroup,
	PageHeader,
	Panel,
	StatusBanner,
	Tooltip
} from '@/components/Primitives';
import { ProviderIcon } from '@/components/ProviderIcon';
import { WildcardModelSelector } from '@/components/WildcardModelSelector';
import {
	invalidProviderApiKey,
	isDatabaseConfigResource,
	makeEmptyModel,
	makeEmptyVirtualModel,
	modelIdentity,
	modelWarnings,
	providerDisplayName,
	providerLabel,
	providerReferenceName,
	upsertModel,
	upsertVirtualModel
} from '@/config';
import type {
	LocalLLMConditionalRouting,
	LocalLLMConditionalTarget,
	LocalLLMFailoverRouting,
	LocalLLMParams,
	LocalLLMWeightedRouting
} from '@/gateway-config';
import {
	useConfigDumpMode,
	useDeleteConfigResource,
	useLlmConfigData,
	useUpsertConfigResource
} from '@/hooks';
import { modelLabel, modelOptionValue, modelSubtitle } from '@/modelLabel';
import {
	concreteModelName,
	isWildcardModelName,
	resolvedProviderLabel,
	selectedConfiguredModelName
} from '@/modelResolution';
import { DumpModelsView } from '@/pages/models/DumpModelsView';
import {
	buildModelMatches,
	ModelMatchesEditor,
	normalizeMatches,
	splitModelMatches
} from '@/pages/models/ModelMatchesEditor';
import {
	HeaderModifierEditor,
	HealthPolicyEditor,
	headerModifierSummary,
	healthSummary,
	PromptCachingEditor,
	promptCachingSummary,
	YamlMappingEditor
} from '@/pages/models/ModelPolicyEditors';
import {
	clearModelSearch,
	type ModelHash,
	modelFromProviderReference,
	modelHashFromUrl,
	providerFromUrl,
	setModelHash
} from '@/pages/models/modelRouteState';
import { ProviderConfigEditor } from '@/pages/models/ProviderConfigEditor';
import {
	defaultVirtualTargetModel,
	failoverTargetGroups,
	isIncompleteWildcardTarget,
	modelTargetOptions,
	virtualModelStrategy,
	virtualModelSummary
} from '@/pages/models/virtualModelUtils';
import { ReadonlyModeBanner } from '@/pages/traffic/TrafficConfigDumpPanel';
import { AuthorizationPolicyEditor } from '@/policies/AuthorizationPolicyEditor';
import { KeyValueEditor } from '@/policies/PolicyFormControls';
import { CollapsiblePolicySection } from '@/policies/PolicyLayout';
import { cleanEmpty, parseYamlText, toYamlText } from '@/policies/policyUtils';
import type { AuthorizationDraft } from '@/policies/types';
import { randomUuid } from '@/randomUuid';
import { type SchemaHelp, useSchemaHelp } from '@/schemaHelp';
import type { GatewayConfig, LlmModel, LlmProvider, LlmVirtualModel, ProviderName } from '@/types';

type VirtualRoutingStrategy = 'weighted' | 'failover' | 'conditional';
type ConditionalVirtualTarget = NonNullable<
	LlmVirtualModel['routing']['conditional']
>['targets'][number];

export function ModelsPage() {
	const mode = useConfigDumpMode();
	if (mode.isLoading) {
		return (
			<div className="page-stack">
				<PageHeader
					title="LLM Models"
					description="Configure the models callers can request and the providers that serve them."
				/>
				<Panel>
					<StatusBanner state="loading" title="Detecting model configuration mode" />
				</Panel>
			</div>
		);
	}
	if (mode.data?.mode === 'dump') {
		return (
			<div className="page-stack">
				<PageHeader
					title="LLM Models"
					description="Read-only model inventory from the active gateway dump."
				/>
				<ReadonlyModeBanner />
				<DumpModelsView models={mode.data.dump.models ?? []} />
			</div>
		);
	}
	return <ModelsEditorPage />;
}

function ModelsEditorPage() {
	const { config, hybrid, resources, models, virtualModels, providers, isLoading, error } =
		useLlmConfigData();
	const upsertResource = useUpsertConfigResource();
	const deleteResource = useDeleteConfigResource();
	const help = useSchemaHelp();
	const [editing, setEditing] = useState<{
		previousId?: string;
		model: LlmModel;
	} | null>(() => {
		const provider = providerFromUrl();
		return provider ? { model: modelFromProviderReference(provider) } : null;
	});
	const [editingVirtual, setEditingVirtual] = useState<{
		previousName?: string;
		model: LlmVirtualModel;
	} | null>(null);
	const [deleting, setDeleting] = useState<{
		kind: 'model' | 'virtual model';
		id: string;
		name: string;
	} | null>(null);
	const [modelHash, setModelHashState] = useState<ModelHash | null>(() => modelHashFromUrl());
	const hashEditModel =
		modelHash?.kind === 'edit'
			? (models.find(model => modelIdentity(model) === modelHash.modelId) ??
				models.find(model => model.name === modelHash.modelId) ??
				null)
			: null;
	const activeEditing =
		editing ??
		(modelHash?.kind === 'add' && modelHash.type === 'model'
			? { model: makeEmptyModel() }
			: null) ??
		(hashEditModel
			? {
					previousId: modelIdentity(hashEditModel),
					model: structuredClone(hashEditModel)
				}
			: null);
	const activeVirtualEditing =
		editingVirtual ??
		(modelHash?.kind === 'add' && modelHash.type === 'virtual'
			? { model: makeEmptyVirtualModel(defaultVirtualTargetModel(models)) }
			: null);
	const editingDatabaseModel = Boolean(
		hybrid &&
			activeEditing &&
			(!activeEditing.previousId ||
				isDatabaseConfigResource(resources, 'llm.model', activeEditing.previousId))
	);
	const editingDatabaseVirtualModel = Boolean(
		hybrid &&
			activeVirtualEditing &&
			(!activeVirtualEditing.previousName ||
				isDatabaseConfigResource(resources, 'llm.virtualModel', activeVirtualEditing.previousName))
	);
	const modelRows = useMemo(
		() => [
			...models.map(model => ({ kind: 'model' as const, model })),
			...virtualModels.map(model => ({ kind: 'virtual' as const, model }))
		],
		[models, virtualModels]
	);

	useEffect(() => {
		function syncSelectedFromUrl() {
			upsertResource.reset();
			deleteResource.reset();
			setEditing(null);
			setEditingVirtual(null);
			setModelHashState(modelHashFromUrl());
		}
		window.addEventListener('hashchange', syncSelectedFromUrl);
		window.addEventListener('popstate', syncSelectedFromUrl);
		return () => {
			window.removeEventListener('hashchange', syncSelectedFromUrl);
			window.removeEventListener('popstate', syncSelectedFromUrl);
		};
	}, [deleteResource, upsertResource]);

	const saving = upsertResource.isPending || deleteResource.isPending;
	const saveError = upsertResource.error?.message ?? deleteResource.error?.message ?? null;
	const saved = upsertResource.isSuccess || deleteResource.isSuccess;

	function openModelEditor(model: LlmModel) {
		resetSaves();
		setEditing(null);
		setModelHashState({ kind: 'edit', modelId: modelIdentity(model) });
		setModelHash({ kind: 'edit', modelId: modelIdentity(model) }, 'push');
	}

	function openNewModel() {
		resetSaves();
		clearModelSearch();
		setModelHashState(null);
		setEditing(null);
		setModelHashState({ kind: 'add', type: 'model' });
		setModelHash({ kind: 'add', type: 'model' }, 'push');
	}

	function openNewVirtualModel() {
		resetSaves();
		clearModelSearch();
		setEditingVirtual(null);
		setModelHashState({ kind: 'add', type: 'virtual' });
		setModelHash({ kind: 'add', type: 'virtual' }, 'push');
	}

	function closeModelEditor() {
		resetSaves();
		setEditing(null);
		clearModelSearch();
		if (modelHash?.kind === 'edit' || (modelHash?.kind === 'add' && modelHash.type === 'model')) {
			setModelHashState(null);
			setModelHash(null, 'replace');
		}
	}

	function closeVirtualModelEditor() {
		resetSaves();
		setEditingVirtual(null);
		if (modelHash?.kind === 'add' && modelHash.type === 'virtual') {
			setModelHashState(null);
			setModelHash(null, 'replace');
		}
	}

	function resetSaves() {
		upsertResource.reset();
		deleteResource.reset();
	}

	function saveModel(model: LlmModel, previousId?: string) {
		if (hybrid) model.id ??= randomUuid();
		upsertResource.mutate(
			{ kind: 'llm.model', value: model, previousId },
			{ onSuccess: closeModelEditor }
		);
	}

	function deleteModel(id: string) {
		deleteResource.mutate(
			{ kind: 'llm.model', id },
			{
				onSuccess: () => setDeleting(null)
			}
		);
	}

	function saveVirtualModel(model: LlmVirtualModel, previousName?: string) {
		upsertResource.mutate(
			{ kind: 'llm.virtualModel', value: model, previousId: previousName },
			{ onSuccess: closeVirtualModelEditor }
		);
	}

	function deleteVirtualModel(name: string) {
		deleteResource.mutate(
			{ kind: 'llm.virtualModel', id: name },
			{
				onSuccess: () => setDeleting(null)
			}
		);
	}

	return (
		<div className="page-stack">
			<PageHeader
				title="LLM Models"
				description="Configure the models callers can request and the providers that serve them."
				actions={
					<div className="button-row">
						<button className="button" type="button" onClick={openNewVirtualModel}>
							<GitBranch size={16} />
							Add virtual model
						</button>
						<button className="button primary" type="button" onClick={openNewModel}>
							<Plus size={16} />
							Add model
						</button>
					</div>
				}
			/>

			{saveError ? (
				<StatusBanner state="bad" title="Save failed">
					{saveError}
				</StatusBanner>
			) : null}
			{saved ? <StatusBanner state="ok" title="Configuration saved" /> : null}

			<Panel>
				{isLoading ? (
					<StatusBanner state="loading" title="Loading models" />
				) : error ? (
					<StatusBanner state="bad" title="Configuration API unavailable">
						{error.message}
					</StatusBanner>
				) : modelRows.length === 0 ? (
					<EmptyState
						title="No models configured"
						description="Create the first model to make LLM traffic available through the gateway."
						action={
							<div className="button-row">
								<button className="button primary" type="button" onClick={openNewModel}>
									<Plus size={16} />
									Add model
								</button>
								<button className="button" type="button" onClick={openNewVirtualModel}>
									<GitBranch size={16} />
									Add virtual model
								</button>
							</div>
						}
					/>
				) : (
					<div className="table-wrap">
						<table>
							<thead>
								<tr>
									<th>Name</th>
									{hybrid ? <th>Source</th> : null}
									<th>Provider</th>
									<th>Outgoing model</th>
									<th>Policy state</th>
									<th />
								</tr>
							</thead>
							<tbody>
								{modelRows.map(row => {
									if (row.kind === 'virtual') {
										const model = row.model;
										const databaseBacked = isDatabaseConfigResource(
											resources,
											'llm.virtualModel',
											model.name
										);
										return (
											<tr key={`virtual:${model.name}`}>
												<td className="strong">{model.name}</td>
												{hybrid ? (
													<td>
														<span className="badge">{databaseBacked ? 'Database' : 'File'}</span>
													</td>
												) : null}
												<td>
													<span className="badge">
														<GitBranch size={14} /> Virtual
													</span>
												</td>
												<td>{virtualModelSummary(model)}</td>
												<td>
													<span className="badge ok">{virtualModelStrategy(model)}</span>
												</td>
												<td className="row-actions">
													<Tooltip content="Open in playground">
														<Link
															className="icon-button"
															aria-label="Open in playground"
															to="/llm/playground"
															search={{ model: model.name }}
														>
															<Play size={16} />
														</Link>
													</Tooltip>
													<Tooltip content="Edit model">
														<button
															className="icon-button"
															aria-label="Edit model"
															type="button"
															onClick={() =>
																setEditingVirtual({
																	previousName: model.name,
																	model: structuredClone(model)
																})
															}
														>
															<Pencil size={16} />
														</button>
													</Tooltip>
													<Tooltip
														content={
															hybrid && !databaseBacked
																? 'File-owned models cannot be deleted here'
																: 'Delete model'
														}
													>
														<button
															className="icon-button danger"
															aria-label="Delete model"
															type="button"
															disabled={saving || (hybrid && !databaseBacked)}
															onClick={() =>
																setDeleting({
																	kind: 'virtual model',
																	id: model.name,
																	name: model.name
																})
															}
														>
															<Trash2 size={16} />
														</button>
													</Tooltip>
												</td>
											</tr>
										);
									}
									const model = row.model;
									const optionValue = modelOptionValue(models, models.indexOf(model));
									const subtitle = modelSubtitle(model);
									const warnings = modelWarnings(model);
									const databaseBacked = isDatabaseConfigResource(
										resources,
										'llm.model',
										modelIdentity(model)
									);
									return (
										<tr key={`model:${model.id ?? optionValue}`}>
											<td className="strong">
												{modelLabel(model)}
												{subtitle ? <div className="model-name-pattern">{subtitle}</div> : null}
											</td>
											{hybrid ? (
												<td>
													<span className="badge">{databaseBacked ? 'Database' : 'File'}</span>
												</td>
											) : null}
											<td>
												<ModelProviderBadge model={model} providers={providers} />
											</td>
											<td>{model.params?.model || 'Incoming model'}</td>
											<td>
												<ModelPolicyState model={model} warnings={warnings.length} />
											</td>
											<td className="row-actions">
												<Tooltip content="Open in playground">
													<Link
														className="icon-button"
														aria-label="Open in playground"
														to="/llm/playground"
														search={{ model: optionValue }}
													>
														<Play size={16} />
													</Link>
												</Tooltip>
												<Tooltip content="Edit model">
													<button
														className="icon-button"
														aria-label="Edit model"
														type="button"
														onClick={() => openModelEditor(model)}
													>
														<Pencil size={16} />
													</button>
												</Tooltip>
												<Tooltip
													content={
														hybrid && !databaseBacked
															? 'File-owned models cannot be deleted here'
															: 'Delete model'
													}
												>
													<button
														className="icon-button danger"
														aria-label="Delete model"
														type="button"
														disabled={saving || (hybrid && !databaseBacked)}
														onClick={() =>
															setDeleting({
																kind: 'model',
																id: modelIdentity(model),
																name: model.name
															})
														}
													>
														<Trash2 size={16} />
													</button>
												</Tooltip>
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					</div>
				)}
			</Panel>

			{activeEditing ? (
				<ModelEditor
					key={activeEditing.previousId ?? 'new'}
					previousId={activeEditing.previousId}
					initial={activeEditing.model}
					config={config.data}
					databaseBacked={editingDatabaseModel}
					providers={providers}
					help={help}
					saving={saving}
					saveError={saveError}
					onCancel={closeModelEditor}
					onSave={saveModel}
				/>
			) : null}
			{activeVirtualEditing && !isLoading ? (
				<VirtualModelEditor
					key={activeVirtualEditing.previousName ?? 'new'}
					previousName={activeVirtualEditing.previousName}
					initial={activeVirtualEditing.model}
					config={config.data}
					databaseBacked={editingDatabaseVirtualModel}
					baseModels={models}
					providers={providers}
					help={help}
					saving={saving}
					saveError={saveError}
					onCancel={closeVirtualModelEditor}
					onSave={saveVirtualModel}
				/>
			) : null}
			{deleting ? (
				<ConfirmDialog
					title={`Delete ${deleting.kind}?`}
					destructive
					confirmLabel={`Delete ${deleting.kind}`}
					confirmDisabled={saving}
					onCancel={() => setDeleting(null)}
					onConfirm={() =>
						deleting.kind === 'virtual model'
							? deleteVirtualModel(deleting.id)
							: deleteModel(deleting.id)
					}
				>
					<p>
						Delete <strong>{deleting.name}</strong>? This cannot be undone.
					</p>
				</ConfirmDialog>
			) : null}
		</div>
	);
}

export type ModelForm = ReturnType<typeof modelFormFrom>;

// The form state for a model: from the saved config, or from raw mode. A model
// without a name matches its provider's default name until one is entered.
function modelFormFrom(model: LlmModel) {
	return {
		// The model itself, for which policy sections start open.
		source: model,
		// The saved matches come from matchRows and matchHeaders. The `matches` key only
		// keeps the saved position of `matches` in the model object.
		model: {
			...(model.name || !model.provider
				? model
				: { ...model, name: defaultIncomingModelMatch(model.provider) }),
			matches: undefined
		},
		...splitModelMatches(model.matches),
		autoModelMatch: !model.name,
		upstreamMode: initialUpstreamMode(model),
		explicitModel: model.params?.model ?? '',
		customModelExpression: model.transformation?.model ?? 'llmRequest.model',
		transformation: expressionMap(model.transformation),
		finalTransformation: expressionMap(model.finalTransformation),
		health: model.health ?? null,
		defaultsText: optionalMappingYamlText(model.defaults),
		overridesText: optionalMappingYamlText(model.overrides),
		requestHeaders: model.requestHeaders ?? null,
		responseHeaders: model.responseHeaders ?? null,
		promptCaching: model.promptCaching ?? null,
		authorization: (model.authorization as AuthorizationDraft | null) ?? null
	};
}

function ModelEditor(props: {
	initial: LlmModel;
	config?: GatewayConfig;
	databaseBacked: boolean;
	providers: LlmProvider[];
	previousId?: string;
	help: SchemaHelp;
	saving: boolean;
	saveError?: string | null;
	onCancel: () => void;
	onSave: (model: LlmModel, previousId?: string) => void;
}) {
	const [initialForm] = useState(() => modelFormFrom(props.initial));
	const [initialDraft] = useState(() => JSON.stringify(initialForm));
	const { control, getValues, register, reset, setValue, watch } = useForm<ModelForm>({
		defaultValues: initialForm
	});
	// watch() returns RHF's live values, which it mutates in place. The clone keeps builders and
	// the useMergedEdits baseline independent of later edits.
	const form = structuredClone(watch());
	const {
		source,
		model,
		upstreamMode,
		explicitModel,
		customModelExpression,
		transformation,
		finalTransformation,
		health,
		defaultsText,
		overridesText,
		requestHeaders,
		responseHeaders,
		promptCaching,
		authorization
	} = form;
	// RHF reads any object with a `target` key as a DOM event, so object values
	// are passed inside an event-shaped wrapper to be stored unchanged.
	const upstreamModeField = useController({ control, name: 'upstreamMode' }).field;
	const explicitModelField = useController({ control, name: 'explicitModel' }).field;
	const customModelExpressionField = useController({
		control,
		name: 'customModelExpression'
	}).field;
	const transformationField = useController({ control, name: 'transformation' }).field;
	const finalTransformationField = useController({ control, name: 'finalTransformation' }).field;
	const healthField = useController({ control, name: 'health' }).field;
	const defaultsTextField = useController({ control, name: 'defaultsText' }).field;
	const overridesTextField = useController({ control, name: 'overridesText' }).field;
	const requestHeadersField = useController({ control, name: 'requestHeaders' }).field;
	const responseHeadersField = useController({ control, name: 'responseHeaders' }).field;
	const promptCachingField = useController({ control, name: 'promptCaching' }).field;
	const authorizationField = useController({ control, name: 'authorization' }).field;
	const providerField = useController({ control, name: 'model.provider' }).field;
	const paramsField = useController({ control, name: 'model.params' }).field;
	const authField = useController({ control, name: 'model.auth' }).field;
	const nameInput = register('model.name', {
		onChange: event => {
			const name = event.target.value;
			setValue(
				'autoModelMatch',
				!name.trim() || name === defaultIncomingModelMatch(model.provider)
			);
		}
	});
	const [policyError, setPolicyError] = useState<string | null>(null);
	const [saveAttempted, setSaveAttempted] = useState(false);
	const warnings = modelWarnings(model);
	const invalidApiKey = invalidProviderApiKey(model.params?.apiKey);
	const providerApiKeyError =
		saveAttempted && invalidApiKey ? 'Enter a value, or choose Unset.' : null;
	const policyPatch = buildModelPolicyPatch({
		transformation,
		finalTransformation,
		health,
		defaultsText,
		overridesText,
		requestHeaders,
		responseHeaders,
		promptCaching,
		authorization
	});
	// The gateway applies the transformation to a fixed model, which the form's
	// single upstream model choice cannot show.
	const fixedAndTransformed = Boolean(source.params?.model && source.transformation?.model);
	const built = fixedAndTransformed
		? source
		: (cleanEmpty(
				applyUpstreamMode(
					{
						...model,
						...policyPatch.value,
						matches: normalizeMatches(buildModelMatches(form))
					},
					upstreamMode,
					explicitModel,
					customModelExpression
				)
			) as LlmModel | undefined);
	const merged = useMergedEdits(props.previousId ? props.initial : undefined, built, [
		'$defs',
		'LocalLLMModels'
	]);
	const preview = merged.value;
	const providerSelected = Boolean(model.provider);

	// Picking a provider also moves the incoming model match to that provider's
	// default, unless the user has typed their own match.
	function changeProvider(provider: LlmModel['provider'], params: LlmModel['params']) {
		const current = getValues();
		const currentDefault = defaultIncomingModelMatch(current.model.provider);
		const nextDefault = defaultIncomingModelMatch(provider);
		const shouldUseDefault =
			current.autoModelMatch || !current.model.name.trim() || current.model.name === currentDefault;
		setValue('autoModelMatch', current.autoModelMatch || shouldUseDefault);
		if (!props.previousId && shouldUseDefault && stripPrefixCandidate(nextDefault)) {
			setValue('upstreamMode', 'strip');
		}
		providerField.onChange({ target: { value: provider } });
		paramsField.onChange({ target: { value: params } });
		if (shouldUseDefault) setValue('model.name', nextDefault);
	}

	function save() {
		setSaveAttempted(true);
		if (!preview?.provider) return;
		if (invalidApiKey) return;
		if (policyPatch.error) {
			setPolicyError(policyPatch.error);
			return;
		}
		setPolicyError(null);
		props.onSave(preview ?? model, props.previousId);
	}

	function validateBeforeDiff() {
		setSaveAttempted(true);
		if (!preview?.provider) return false;
		if (invalidApiKey) return false;
		if (policyPatch.error) {
			setPolicyError(policyPatch.error);
			return false;
		}
		setPolicyError(null);
		return true;
	}

	return (
		<Drawer
			title={props.previousId ? 'Edit model' : 'Add model'}
			onClose={props.onCancel}
			dirty={JSON.stringify(form) !== initialDraft}
			saving={props.saving}
			error={props.saveError}
			raw={{
				schemaPath: ['$defs', 'LocalLLMModels'],
				value: () => preview ?? model,
				onChange: value => {
					reset(modelFormFrom(value as LlmModel));
					merged.reset(value);
				},
				empty: makeEmptyModel()
			}}
			footer={requestClose => (
				<ConfigDiffSaveActions
					config={props.config}
					resourceDiff={
						props.databaseBacked
							? {
									original: props.previousId ? modelConfigForDisplay(props.initial) : {},
									modified: modelConfigForDisplay(preview)
								}
							: undefined
					}
					diffTitle={props.databaseBacked ? 'Model resource diff' : 'Model config diff'}
					saveLabel="Save model"
					saving={props.saving}
					onCancel={requestClose}
					onSave={save}
					beforeDiff={validateBeforeDiff}
					applyDiff={next => upsertModel(next, preview ?? model, props.previousId)}
				/>
			)}
		>
			{fixedAndTransformed ? (
				<UnsupportedInForm supports="either a fixed upstream model or a model transformation" />
			) : null}
			<LostFieldsWarning lost={merged.lost} />
			<details className="schema-details model-help-details">
				<summary>Help</summary>
				<div className="model-help-copy">
					<p>
						Agentgateway routes requests by matching an incoming model name, and then sending it to
						the configured model. The outgoing model can be passed through from the incoming model,
						be transformed, or be a static model.
					</p>
					<p>Some examples:</p>
					<ul>
						<li>
							Match <code>fast</code> and send to <code>gpt-mini</code>.
						</li>
						<li>
							Match <code>*</code> and forward the model as-is.
						</li>
						<li>
							Match <code>openai/*</code> and strip the <code>openai/</code> prefix, forwarding the
							remaining model as-is.
						</li>
					</ul>
				</div>
			</details>

			<div className="form-grid">
				<Field
					label="Incoming model match"
					path="name"
					tooltip={props.help.field<LlmModel>(
						'LocalLLMModels',
						'name',
						'The model name matched from incoming requests. Use an exact name like gpt-4.1-mini or a wildcard like openai/*.'
					)}
				>
					<input
						{...nameInput}
						placeholder={model.provider ? defaultIncomingModelMatch(model.provider) : 'openai/*'}
					/>
				</Field>
				<Field
					label="Display name"
					path="displayName"
					tooltip={props.help.field<LlmModel>(
						'LocalLLMModels',
						'displayName',
						'Optional label for lists and pickers. Matching still uses the incoming model match.'
					)}
				>
					<input
						value={model.displayName ?? ''}
						onChange={event => setValue('model.displayName', event.target.value || undefined)}
						placeholder="Defaults to the model match"
					/>
				</Field>
			</div>

			<ProviderConfigEditor
				provider={model.provider}
				params={model.params}
				auth={model.auth}
				providers={props.providers}
				help={props.help}
				apiKeyError={providerApiKeyError}
				onProviderChange={changeProvider}
				onParamsChange={params => paramsField.onChange({ target: { value: params } })}
				onAuthChange={auth => authField.onChange({ target: { value: auth } })}
			/>

			{providerSelected ? (
				<>
					<UpstreamModelFields
						mode={upstreamMode}
						explicitModel={explicitModel}
						customModelExpression={customModelExpression}
						gatewayModelName={model.name}
						provider={
							model.provider ? resolvedProviderLabel(model.provider, props.providers) : null
						}
						help={props.help}
						setMode={upstreamModeField.onChange}
						setExplicitModel={explicitModelField.onChange}
						setCustomModelExpression={customModelExpressionField.onChange}
					/>

					<CollapsiblePolicySection
						icon={<SlidersHorizontal size={17} />}
						title="Advanced"
						description="Match conditions and model-specific policies"
					>
						<div className="policy-editor-stack">
							<ModelMatchesEditor control={control} setValue={setValue} />

							<ModelPoliciesInline
								model={source}
								help={props.help}
								transformation={transformation}
								finalTransformation={finalTransformation}
								health={health}
								defaultsText={defaultsText}
								overridesText={overridesText}
								requestHeaders={requestHeaders}
								responseHeaders={responseHeaders}
								promptCaching={promptCaching}
								authorization={authorization}
								setTransformation={value => transformationField.onChange({ target: { value } })}
								setFinalTransformation={value =>
									finalTransformationField.onChange({ target: { value } })
								}
								setHealth={value => healthField.onChange({ target: { value } })}
								setDefaultsText={defaultsTextField.onChange}
								setOverridesText={overridesTextField.onChange}
								setRequestHeaders={value => requestHeadersField.onChange({ target: { value } })}
								setResponseHeaders={value => responseHeadersField.onChange({ target: { value } })}
								setPromptCaching={value => promptCachingField.onChange({ target: { value } })}
								setAuthorization={value => authorizationField.onChange({ target: { value } })}
							/>
						</div>
					</CollapsiblePolicySection>
				</>
			) : null}

			{providerSelected && warnings.length ? (
				<div className="model-warning-block">
					<StatusBanner state="warn" title="Model warnings">
						<ul>
							{warnings.map(warning => (
								<li key={warning}>{warning}</li>
							))}
						</ul>
					</StatusBanner>
				</div>
			) : null}
			{policyError ? (
				<StatusBanner state="bad" title="Invalid model policies">
					{policyError}
				</StatusBanner>
			) : null}
		</Drawer>
	);
}

type UpstreamModelMode = 'incoming' | 'explicit' | 'strip' | 'custom';

function UpstreamModelFields(props: {
	mode: UpstreamModelMode;
	explicitModel: string;
	customModelExpression: string;
	gatewayModelName: string;
	provider?: string | null;
	help: SchemaHelp;
	setMode: (mode: UpstreamModelMode) => void;
	setExplicitModel: (model: string) => void;
	setCustomModelExpression: (expression: string) => void;
}) {
	const prefix = stripPrefixCandidate(props.gatewayModelName);
	const mode = prefix || props.mode !== 'strip' ? props.mode : 'incoming';
	const stripLabel = prefix ? `Strip ${prefix.slice(0, -1)}/` : 'Strip prefix';
	return (
		<>
			<FieldGroup
				label="Outgoing model"
				tooltip={props.help.field<LocalLLMParams>('LocalLLMParams', 'model')}
			>
				<div className="segmented-control upstream-model-control">
					<button
						className={mode === 'incoming' ? 'active' : ''}
						type="button"
						onClick={() => props.setMode('incoming')}
					>
						Incoming model
					</button>
					<button
						className={mode === 'explicit' ? 'active' : ''}
						type="button"
						onClick={() => props.setMode('explicit')}
					>
						Explicit
					</button>
					{prefix ? (
						<button
							className={mode === 'strip' ? 'active' : ''}
							type="button"
							onClick={() => props.setMode('strip')}
						>
							{stripLabel}
						</button>
					) : null}
					<button
						className={mode === 'custom' ? 'active' : ''}
						type="button"
						onClick={() => props.setMode('custom')}
					>
						Custom
					</button>
				</div>
			</FieldGroup>

			{mode === 'explicit' ? (
				<Field
					label="Explicit outgoing model"
					tooltip={props.help.field<LocalLLMParams>('LocalLLMParams', 'model')}
				>
					<CatalogModelSelector
						ariaLabel="Explicit outgoing model"
						value={props.explicitModel}
						provider={props.provider}
						onChange={props.setExplicitModel}
						placeholder="gpt-4.1-mini"
					/>
				</Field>
			) : null}
			{mode === 'custom' ? (
				<FieldGroup
					label="Model CEL expression"
					tooltip={props.help.field<LlmModel>('LocalLLMModels', 'transformation')}
				>
					<MiniMonacoEditor
						language="cel"
						value={props.customModelExpression}
						onChange={props.setCustomModelExpression}
						placeholder='llmRequest.model.stripPrefix("anthropic/")'
					/>
				</FieldGroup>
			) : null}
		</>
	);
}

function ModelPoliciesInline(props: {
	model: LlmModel;
	help: SchemaHelp;
	transformation: Record<string, string>;
	finalTransformation: Record<string, string>;
	health: LlmModel['health'];
	defaultsText: string;
	overridesText: string;
	requestHeaders: LlmModel['requestHeaders'];
	responseHeaders: LlmModel['responseHeaders'];
	promptCaching: LlmModel['promptCaching'];
	authorization: AuthorizationDraft | null;
	setTransformation: (value: Record<string, string>) => void;
	setFinalTransformation: (value: Record<string, string>) => void;
	setHealth: (value: LlmModel['health'] | null) => void;
	setDefaultsText: (value: string) => void;
	setOverridesText: (value: string) => void;
	setRequestHeaders: (value: LlmModel['requestHeaders'] | null) => void;
	setResponseHeaders: (value: LlmModel['responseHeaders'] | null) => void;
	setPromptCaching: (value: LlmModel['promptCaching'] | null) => void;
	setAuthorization: (value: AuthorizationDraft | null) => void;
}) {
	const patch = buildModelPolicyPatch(props);
	const transformationEnabled = Object.keys(expressionMap(props.model.transformation)).length > 0;
	const finalTransformationEnabled =
		Object.keys(expressionMap(props.model.finalTransformation)).length > 0;
	const defaultsEnabled = Boolean(props.model.defaults && Object.keys(props.model.defaults).length);
	const overridesEnabled = Boolean(
		props.model.overrides && Object.keys(props.model.overrides).length
	);
	return (
		<CollapsiblePolicySection
			icon={<SlidersHorizontal size={17} />}
			title="Model policies"
			description={modelPolicySummary({ ...props.model, ...patch.value })}
		>
			<div className="policy-editor-stack">
				<CollapsiblePolicySection
					icon={<SlidersHorizontal size={17} />}
					title="Transformation"
					description={
						Object.keys(props.transformation).length
							? `${Object.keys(props.transformation).length} fields configured`
							: 'No fields configured'
					}
					defaultOpen={transformationEnabled}
				>
					<KeyValueEditor
						label="LLM request fields"
						tooltip={props.help.field<LlmModel>('LocalLLMModels', 'transformation')}
						values={props.transformation}
						keyPlaceholder="field name"
						valuePlaceholder="CEL expression"
						valueKind="cel"
						onChange={props.setTransformation}
					/>
				</CollapsiblePolicySection>
				<CollapsiblePolicySection
					icon={<SlidersHorizontal size={17} />}
					title="Final transformation"
					description={
						Object.keys(props.finalTransformation).length
							? `${Object.keys(props.finalTransformation).length} fields configured`
							: 'No fields configured'
					}
					defaultOpen={finalTransformationEnabled}
				>
					<KeyValueEditor
						label="Provider request fields"
						tooltip={props.help.field<LlmModel>('LocalLLMModels', 'finalTransformation')}
						values={props.finalTransformation}
						keyPlaceholder="field name"
						valuePlaceholder="CEL expression"
						valueKind="cel"
						onChange={props.setFinalTransformation}
					/>
				</CollapsiblePolicySection>
				<CollapsiblePolicySection
					icon={<FileText size={17} />}
					title="Default request values"
					description={props.defaultsText.trim() ? 'Defaults configured' : 'No defaults configured'}
					defaultOpen={defaultsEnabled}
				>
					<YamlMappingEditor
						label="Defaults YAML"
						tooltip={props.help.field<LlmModel>('LocalLLMModels', 'defaults')}
						value={props.defaultsText}
						onChange={props.setDefaultsText}
						placeholder="temperature: 0.2"
					/>
				</CollapsiblePolicySection>
				<CollapsiblePolicySection
					icon={<FileText size={17} />}
					title="Override request values"
					description={
						props.overridesText.trim() ? 'Overrides configured' : 'No overrides configured'
					}
					defaultOpen={overridesEnabled}
				>
					<YamlMappingEditor
						label="Overrides YAML"
						tooltip={props.help.field<LlmModel>('LocalLLMModels', 'overrides')}
						value={props.overridesText}
						onChange={props.setOverridesText}
						placeholder="stream: false"
					/>
				</CollapsiblePolicySection>
				<CollapsiblePolicySection
					icon={<SlidersHorizontal size={17} />}
					title="Request headers"
					description={headerModifierSummary(props.requestHeaders, 'request')}
					defaultOpen={Boolean(props.model.requestHeaders)}
				>
					<HeaderModifierEditor
						value={props.requestHeaders}
						help={props.help}
						onChange={props.setRequestHeaders}
					/>
				</CollapsiblePolicySection>
				<CollapsiblePolicySection
					icon={<SlidersHorizontal size={17} />}
					title="Response headers"
					description={headerModifierSummary(props.responseHeaders, 'response')}
					defaultOpen={Boolean(props.model.responseHeaders)}
				>
					<HeaderModifierEditor
						value={props.responseHeaders}
						help={props.help}
						onChange={props.setResponseHeaders}
					/>
				</CollapsiblePolicySection>
				<CollapsiblePolicySection
					icon={<Activity size={17} />}
					title="Health"
					description={healthSummary(props.health)}
					defaultOpen={Boolean(props.model.health)}
				>
					<HealthPolicyEditor health={props.health} help={props.help} onChange={props.setHealth} />
				</CollapsiblePolicySection>
				<CollapsiblePolicySection
					icon={<ShieldCheck size={17} />}
					title="Authorization"
					description={authorizationSummary(props.authorization)}
					defaultOpen={Boolean(props.model.authorization)}
				>
					<div className="policy-editor-stack compact">
						<AuthorizationPolicyEditor
							key={JSON.stringify(props.authorization ?? null)}
							authorization={props.authorization}
							saving={false}
							onSave={props.setAuthorization}
						/>
						{props.authorization ? (
							<button className="button" type="button" onClick={() => props.setAuthorization(null)}>
								Clear authorization
							</button>
						) : null}
					</div>
				</CollapsiblePolicySection>
				<CollapsiblePolicySection
					icon={<SlidersHorizontal size={17} />}
					title="Prompt caching"
					description={promptCachingSummary(props.promptCaching)}
					defaultOpen={Boolean(props.model.promptCaching)}
				>
					<PromptCachingEditor
						value={props.promptCaching}
						help={props.help}
						onChange={props.setPromptCaching}
					/>
				</CollapsiblePolicySection>
			</div>
		</CollapsiblePolicySection>
	);
}

function buildModelPolicyPatch(args: {
	transformation: Record<string, string>;
	finalTransformation: Record<string, string>;
	health: LlmModel['health'];
	defaultsText: string;
	overridesText: string;
	requestHeaders: LlmModel['requestHeaders'];
	responseHeaders: LlmModel['responseHeaders'];
	promptCaching: LlmModel['promptCaching'];
	authorization: AuthorizationDraft | null;
}) {
	try {
		const defaults = parseOptionalYamlMapping(args.defaultsText);
		const overrides = parseOptionalYamlMapping(args.overridesText);
		const transformation = cleanEmpty(args.transformation) as
			| LlmModel['transformation']
			| undefined;
		const finalTransformation = cleanEmpty(args.finalTransformation) as
			| LlmModel['finalTransformation']
			| undefined;
		const health = cleanEmpty(args.health) as LlmModel['health'] | undefined;
		const requestHeaders = cleanEmpty(args.requestHeaders) as
			| LlmModel['requestHeaders']
			| undefined;
		const responseHeaders = cleanEmpty(args.responseHeaders) as
			| LlmModel['responseHeaders']
			| undefined;
		const promptCaching = cleanEmpty(args.promptCaching) as LlmModel['promptCaching'] | undefined;
		const authorization = cleanEmpty(args.authorization) as LlmModel['authorization'] | undefined;
		return {
			value: {
				defaults,
				overrides,
				transformation:
					transformation && Object.keys(transformation).length ? transformation : null,
				finalTransformation:
					finalTransformation && Object.keys(finalTransformation).length
						? finalTransformation
						: null,
				requestHeaders:
					requestHeaders && Object.keys(requestHeaders).length ? requestHeaders : null,
				responseHeaders:
					responseHeaders && Object.keys(responseHeaders).length ? responseHeaders : null,
				health: health && Object.keys(health).length ? health : null,
				promptCaching: promptCaching && Object.keys(promptCaching).length ? promptCaching : null,
				authorization: authorization && Object.keys(authorization).length ? authorization : null
			} satisfies Partial<LlmModel>,
			error: null
		};
	} catch (error) {
		return {
			value: {},
			error: error instanceof Error ? error.message : 'Invalid policy configuration'
		};
	}
}

function modelPolicySummary(model: Partial<LlmModel>) {
	const policies = [
		model.defaults && Object.keys(model.defaults).length ? 'defaults' : null,
		model.overrides && Object.keys(model.overrides).length ? 'overrides' : null,
		model.transformation && Object.keys(model.transformation).length ? 'transformation' : null,
		model.finalTransformation && Object.keys(model.finalTransformation).length
			? 'final transformation'
			: null,
		model.requestHeaders ? 'request headers' : null,
		model.responseHeaders ? 'response headers' : null,
		model.health ? 'health' : null,
		model.authorization ? 'authorization' : null,
		model.promptCaching ? 'prompt caching' : null
	].filter(Boolean);
	return policies.length ? `${policies.length} configured` : 'No model policies configured';
}

type VirtualWeightedTarget = NonNullable<LlmVirtualModel['routing']['weighted']>['targets'][number];
type VirtualFailoverTarget = NonNullable<LlmVirtualModel['routing']['failover']>['targets'][number];
type VirtualTargetOptions = ReturnType<typeof modelTargetOptions>;

// The virtual model form. Each strategy keeps its targets in its own field
// array, so rows keep their ids when a sibling is removed. Failover targets are
// one flat list, owned by a `failoverGroups` row (their owner is its index). `model.routing` is
// the loaded routing: it is used only when no strategy is set, and otherwise
// the saved routing replaces it in place, so the saved key order is unchanged.
type VirtualModelForm = {
	model: LlmVirtualModel;
	strategy: VirtualRoutingStrategy | undefined;
	weightedTargets: VirtualWeightedTarget[];
	failoverGroups: Array<Record<string, never>>;
	failoverTargets: Array<VirtualFailoverTarget & { owner: number }>;
	conditionalTargets: ConditionalVirtualTarget[];
};

function virtualModelFormFrom(model: LlmVirtualModel): VirtualModelForm {
	const routing = model.routing;
	return {
		model,
		strategy: routingStrategy(routing),
		weightedTargets: routing.weighted?.targets ?? [],
		failoverGroups: failoverTargetGroups(routing.failover?.targets ?? []).map(() => ({})),
		failoverTargets: failoverTargetGroups(routing.failover?.targets ?? []).flatMap(
			(targets, owner) => targets.map(target => ({ owner, ...target }))
		),
		conditionalTargets: routing.conditional?.targets ?? []
	};
}

function routingStrategy(routing: LlmVirtualModel['routing']): VirtualRoutingStrategy | undefined {
	if (routing.conditional) return 'conditional';
	if (routing.failover) return 'failover';
	if (routing.weighted) return 'weighted';
	return undefined;
}

function buildVirtualModel(form: VirtualModelForm): LlmVirtualModel {
	return { ...form.model, routing: buildVirtualRouting(form) };
}

// Failover priorities are stored on each target and renumbered by the editor
// on every failover edit, so untouched targets keep their saved priority.
function buildVirtualRouting(form: VirtualModelForm): LlmVirtualModel['routing'] {
	switch (form.strategy) {
		case 'weighted':
			return { weighted: { targets: form.weightedTargets } };
		case 'failover':
			return {
				failover: { targets: form.failoverTargets.map(({ owner: _owner, ...target }) => target) }
			};
		case 'conditional':
			return { conditional: { targets: form.conditionalTargets } };
		default:
			return form.model.routing;
	}
}

function VirtualModelEditor(props: {
	initial: LlmVirtualModel;
	config?: GatewayConfig;
	databaseBacked: boolean;
	previousName?: string;
	baseModels: LlmModel[];
	providers: LlmProvider[];
	help: SchemaHelp;
	saving: boolean;
	saveError?: string | null;
	onCancel: () => void;
	onSave: (model: LlmVirtualModel, previousName?: string) => void;
}) {
	const [initialForm] = useState(() => virtualModelFormFrom(props.initial));
	const [initialDraft] = useState(() => JSON.stringify(initialForm));
	const { control, getValues, register, reset, setValue, watch } = useForm<VirtualModelForm>({
		defaultValues: initialForm
	});
	// watch() returns RHF's live values, which it mutates in place. The clone keeps builders and
	// the useMergedEdits baseline independent of later edits.
	const form = structuredClone(watch());
	const model = buildVirtualModel(form);
	const strategy = form.strategy;
	const weighted = useFieldArray({ control, name: 'weightedTargets' });
	const failoverGroups = useFieldArray({ control, name: 'failoverGroups' });
	const failover = useFieldArray({ control, name: 'failoverTargets' });
	const conditional = useFieldArray({ control, name: 'conditionalTargets' });
	const targetOptions = modelTargetOptions(props.baseModels, props.providers);
	const merged = useMergedEdits(
		props.previousName ? props.initial : undefined,
		cleanEmpty(model) as LlmVirtualModel | undefined,
		['$defs', 'LocalLLMVirtualModel']
	);
	const preview = merged.value;
	const activeTargets =
		strategy === 'weighted'
			? form.weightedTargets
			: strategy === 'failover'
				? form.failoverTargets
				: form.conditionalTargets;
	const hasInvalidTarget = activeTargets.some(
		target => !target.model.trim() || isIncompleteWildcardTarget(target.model, props.baseModels)
	);
	const hasInvalidConditionalFallback =
		strategy === 'conditional' &&
		form.conditionalTargets.some(
			(target, index) => !target.when?.trim() && index !== form.conditionalTargets.length - 1
		);
	const defaultTarget = defaultVirtualTargetModel(props.baseModels);
	const saveDisabled =
		props.saving ||
		(strategy !== undefined &&
			(activeTargets.length === 0 || hasInvalidTarget || hasInvalidConditionalFallback));

	// Failover priority is the group position. Each target's priority is written
	// in place, so rows keep their field ids.
	function renumberFailover() {
		getValues('failoverTargets').forEach((target, position) => {
			setValue(`failoverTargets.${position}.priority`, target.owner);
		});
	}

	function setStrategy(next: VirtualRoutingStrategy) {
		setValue('strategy', next);
		if (next !== 'weighted') weighted.remove();
		if (next !== 'failover') {
			failover.remove();
			failoverGroups.remove();
		}
		if (next !== 'conditional') conditional.remove();
		if (next === 'weighted' && !getValues('weightedTargets').length)
			weighted.append({ model: defaultTarget, weight: 1 });
		if (next === 'failover' && !getValues('failoverTargets').length) {
			failoverGroups.append({});
			failover.append({ owner: 0, model: defaultTarget, priority: 0 });
		}
		if (next === 'conditional' && !getValues('conditionalTargets').length)
			conditional.append([
				{ when: 'json(request.body).route == "default"', model: defaultTarget },
				{ model: defaultTarget }
			]);
	}

	function addFailoverGroup() {
		const owner = getValues('failoverGroups').length;
		failoverGroups.append({});
		failover.append({ owner, model: defaultTarget, priority: owner });
		renumberFailover();
	}

	// Targets owned by later groups move down one owner, then the group's targets
	// and group row are removed. The owner rewrites are primitive leaves, so they
	// do not touch the row ids.
	function removeFailoverGroup(groupIndex: number) {
		const owned: number[] = [];
		getValues('failoverTargets').forEach((target, position) => {
			if (target.owner === groupIndex) owned.push(position);
			if (target.owner > groupIndex) {
				setValue(`failoverTargets.${position}.owner`, target.owner - 1);
			}
		});
		failover.remove(owned);
		failoverGroups.remove(groupIndex);
		renumberFailover();
	}

	// Removing a group's last target removes the group, so no group is left empty.
	function removeFailoverTarget(position: number) {
		const targets = getValues('failoverTargets');
		const owner = targets[position].owner;
		if (targets.filter(target => target.owner === owner).length === 1) {
			removeFailoverGroup(owner);
			return;
		}
		failover.remove(position);
		renumberFailover();
	}

	// A group's targets are contiguous, so a new one goes after the last target of
	// every group up to and including `groupIndex`.
	function addFailoverTarget(groupIndex: number) {
		const position = getValues('failoverTargets').filter(
			target => target.owner <= groupIndex
		).length;
		failover.insert(position, { owner: groupIndex, model: defaultTarget, priority: groupIndex });
		renumberFailover();
	}

	return (
		<Drawer
			title={props.previousName ? 'Edit virtual model' : 'Add virtual model'}
			onClose={props.onCancel}
			dirty={JSON.stringify(form) !== initialDraft}
			saving={props.saving}
			error={props.saveError}
			raw={{
				schemaPath: ['$defs', 'LocalLLMVirtualModel'],
				value: () => preview ?? model,
				onChange: value => {
					const next = value as LlmVirtualModel;
					reset(virtualModelFormFrom(next));
					merged.reset(value);
				},
				empty: makeEmptyVirtualModel(defaultTarget)
			}}
			footer={requestClose => (
				<ConfigDiffSaveActions
					config={props.config}
					resourceDiff={
						props.databaseBacked
							? {
									original: props.previousName ? props.initial : {},
									modified: preview ?? {}
								}
							: undefined
					}
					diffTitle={
						props.databaseBacked ? 'Virtual model resource diff' : 'Virtual model config diff'
					}
					saveLabel="Save virtual model"
					saving={props.saving}
					saveDisabled={saveDisabled}
					onCancel={requestClose}
					onSave={() => props.onSave(preview ?? model, props.previousName)}
					applyDiff={next => upsertVirtualModel(next, preview ?? model, props.previousName)}
				/>
			)}
		>
			{strategy ? null : (
				<UnsupportedInForm supports="weighted, failover, and conditional routing" />
			)}
			<LostFieldsWarning lost={merged.lost} />
			<Field
				label="Virtual model name"
				path="name"
				tooltip={props.help.field<LlmVirtualModel>('LocalLLMVirtualModel', 'name')}
			>
				<input {...register('model.name')} placeholder="resilient" />
			</Field>

			<FieldGroup
				label="Routing strategy"
				tooltip={props.help.field<LlmVirtualModel>('LocalLLMVirtualModel', 'routing')}
			>
				<div className="segmented-control">
					<button
						className={strategy === 'weighted' ? 'active' : ''}
						type="button"
						onClick={() => setStrategy('weighted')}
					>
						Weighted
					</button>
					<button
						className={strategy === 'failover' ? 'active' : ''}
						type="button"
						onClick={() => setStrategy('failover')}
					>
						Failover
					</button>
					<button
						className={strategy === 'conditional' ? 'active' : ''}
						type="button"
						onClick={() => setStrategy('conditional')}
					>
						Conditional
					</button>
				</div>
			</FieldGroup>

			{strategy === 'weighted' ? (
				<FieldGroup
					label="Weighted targets"
					tooltip={props.help.field<LocalLLMWeightedRouting>('LocalLLMWeightedRouting', 'targets')}
				>
					<div className="target-list">
						{weighted.fields.map((field, index) => (
							<WeightedTargetRow
								key={field.id}
								index={index}
								control={control}
								baseModels={props.baseModels}
								options={targetOptions}
								providers={props.providers}
								onRemove={() => weighted.remove(index)}
							/>
						))}
					</div>
					<button
						className="button"
						type="button"
						onClick={() => weighted.append({ model: defaultTarget, weight: 1 })}
					>
						<Plus size={16} />
						Add target
					</button>
				</FieldGroup>
			) : strategy === 'failover' ? (
				<FieldGroup
					label="Failover targets"
					tooltip={props.help.field<LocalLLMFailoverRouting>('LocalLLMFailoverRouting', 'targets')}
				>
					<div className="failover-group-list">
						{failoverGroups.fields.map((field, groupIndex) => (
							<FailoverGroupCard
								key={field.id}
								groupIndex={groupIndex}
								rows={failover.fields.flatMap((target, position) =>
									target.owner === groupIndex ? [{ id: target.id, position }] : []
								)}
								control={control}
								baseModels={props.baseModels}
								options={targetOptions}
								providers={props.providers}
								onAddTarget={() => addFailoverTarget(groupIndex)}
								onRemoveTarget={removeFailoverTarget}
								onRemoveGroup={() => removeFailoverGroup(groupIndex)}
								onRenumber={renumberFailover}
							/>
						))}
					</div>
					<button className="button" type="button" onClick={addFailoverGroup}>
						<Plus size={16} />
						Add fallback group
					</button>
				</FieldGroup>
			) : (
				<FieldGroup
					label="Conditional targets"
					tooltip={props.help.field<LocalLLMConditionalRouting>(
						'LocalLLMConditionalRouting',
						'targets'
					)}
				>
					<div className="target-list">
						{conditional.fields.map((field, index) => (
							<ConditionalTargetCard
								key={field.id}
								index={index}
								count={conditional.fields.length}
								control={control}
								help={props.help}
								baseModels={props.baseModels}
								options={targetOptions}
								providers={props.providers}
								onRemove={() => conditional.remove(index)}
							/>
						))}
					</div>
					{hasInvalidConditionalFallback ? (
						<StatusBanner
							state="warn"
							title="Only the final conditional target can omit a condition."
						/>
					) : null}
					<div className="button-row">
						<button
							className="button"
							type="button"
							onClick={() =>
								conditional.append({
									when: 'json(request.body).route == "code"',
									model: defaultTarget
								})
							}
						>
							<Plus size={16} />
							Add rule
						</button>
						<button
							className="button"
							type="button"
							onClick={() => {
								// Replaces the fallback, keeping the rules in order.
								const fallbacks = getValues('conditionalTargets').flatMap((target, index) =>
									target.when?.trim() ? [] : [index]
								);
								conditional.remove(fallbacks);
								conditional.append({ model: defaultTarget });
							}}
						>
							<Plus size={16} />
							Add fallback
						</button>
					</div>
				</FieldGroup>
			)}
		</Drawer>
	);
}

function WeightedTargetRow(props: {
	index: number;
	control: Control<VirtualModelForm>;
	baseModels: LlmModel[];
	options: VirtualTargetOptions;
	providers: LlmProvider[];
	onRemove: () => void;
}) {
	const { control, index } = props;
	return (
		<div className="target-row weighted">
			<Controller
				control={control}
				name={`weightedTargets.${index}.model`}
				render={({ field }) => (
					<VirtualTargetSelector
						label="Model"
						targetModel={field.value}
						baseModels={props.baseModels}
						options={props.options}
						providers={props.providers}
						onChange={field.onChange}
					/>
				)}
			/>
			<WeightField control={control} name={`weightedTargets.${index}.weight`} />
			<button
				className="icon-button danger"
				type="button"
				aria-label="Remove target"
				onClick={props.onRemove}
			>
				<Trash2 size={16} />
			</button>
		</div>
	);
}

// A failover group is a row of `failoverGroups`. Its targets are the rows of
// `failoverTargets` whose owner is its index.
function FailoverGroupCard(props: {
	groupIndex: number;
	rows: Array<{ id: string; position: number }>;
	control: Control<VirtualModelForm>;
	baseModels: LlmModel[];
	options: VirtualTargetOptions;
	providers: LlmProvider[];
	onAddTarget: () => void;
	onRemoveTarget: (position: number) => void;
	onRemoveGroup: () => void;
	onRenumber: () => void;
}) {
	return (
		<section className="match-card">
			<div className="match-card-header">
				<strong>
					{props.groupIndex === 0 ? 'First attempt' : `Fallback group ${props.groupIndex + 1}`}
				</strong>
				<Tooltip content="Remove group">
					<button
						className="icon-button danger"
						type="button"
						aria-label={`Remove failover group ${props.groupIndex + 1}`}
						onClick={props.onRemoveGroup}
					>
						<Trash2 size={15} />
					</button>
				</Tooltip>
			</div>
			<div className="match-card-body">
				<div className="target-list">
					{props.rows.map(row => (
						<div className="target-row failover" key={row.id}>
							<Controller
								control={props.control}
								name={`failoverTargets.${row.position}.model`}
								render={({ field }) => (
									<VirtualTargetSelector
										label="Model"
										targetModel={field.value}
										baseModels={props.baseModels}
										options={props.options}
										providers={props.providers}
										onChange={value => {
											field.onChange(value);
											props.onRenumber();
										}}
									/>
								)}
							/>
							<button
								className="icon-button danger"
								type="button"
								aria-label="Remove target"
								onClick={() => props.onRemoveTarget(row.position)}
							>
								<Trash2 size={16} />
							</button>
						</div>
					))}
				</div>
				<button className="button small" type="button" onClick={props.onAddTarget}>
					<Plus size={16} />
					Add target
				</button>
			</div>
		</section>
	);
}

function ConditionalTargetCard(props: {
	index: number;
	count: number;
	control: Control<VirtualModelForm>;
	help: SchemaHelp;
	baseModels: LlmModel[];
	options: VirtualTargetOptions;
	providers: LlmProvider[];
	onRemove: () => void;
}) {
	const { control, index } = props;
	const when = useWatch({ control, name: `conditionalTargets.${index}.when` });
	const isFallback = !when?.trim();
	return (
		<div className="conditional-target-card">
			<div className="match-card-header">
				<strong>{isFallback ? 'Fallback' : `Rule ${index + 1}`}</strong>
				<Tooltip content="Remove rule">
					<button
						className="icon-button danger"
						type="button"
						aria-label="Remove conditional target"
						onClick={props.onRemove}
					>
						<Trash2 size={15} />
					</button>
				</Tooltip>
			</div>
			<div className="conditional-target-body">
				<FieldGroup
					label="Condition"
					tooltip={props.help.field<LocalLLMConditionalTarget>('LocalLLMConditionalTarget', 'when')}
				>
					<Controller
						control={control}
						name={`conditionalTargets.${index}.when`}
						render={({ field }) => (
							<MiniMonacoEditor
								language="cel"
								value={field.value ?? ''}
								onChange={value => field.onChange(value.trim() ? value : undefined)}
								placeholder={
									index === props.count - 1
										? 'Blank final condition means fallback'
										: 'json(request.body).route == "code"'
								}
							/>
						)}
					/>
				</FieldGroup>
				<Controller
					control={control}
					name={`conditionalTargets.${index}.model`}
					render={({ field }) => (
						<VirtualTargetSelector
							label="Target model"
							targetModel={field.value}
							baseModels={props.baseModels}
							options={props.options}
							providers={props.providers}
							onChange={field.onChange}
						/>
					)}
				/>
			</div>
		</div>
	);
}

function WeightField(props: {
	control: Control<VirtualModelForm>;
	name: `weightedTargets.${number}.weight`;
}) {
	const { field } = useController({ control: props.control, name: props.name });
	return (
		<label className="target-field">
			<span className="target-label">Weight</span>
			<input
				aria-label="Weight"
				value={field.value ?? 1}
				onChange={event => field.onChange(Number(event.target.value) || 1)}
				type="number"
				min={1}
			/>
		</label>
	);
}

function VirtualTargetSelector(props: {
	label: string;
	targetModel: string;
	baseModels: LlmModel[];
	options: Array<{
		value: string;
		label: ReactNode;
		icon?: ReactNode;
		searchText?: string;
	}>;
	providers: LlmProvider[];
	onChange: (model: string) => void;
}) {
	const selectedModelName = selectedConfiguredModelName(props.targetModel, props.baseModels);
	const selectedModel = props.baseModels.find(model => model.name === selectedModelName);
	const provider = selectedModel
		? resolvedProviderLabel(selectedModel.provider, props.providers)
		: null;

	return (
		<div className="target-field">
			<span className="target-label">{props.label}</span>
			<Dropdown
				ariaLabel={props.label}
				value={selectedModelName}
				searchable
				options={props.options}
				placeholder="No configured models"
				onChange={value => props.onChange(concreteModelName(value, ''))}
			/>
			{selectedModel && isWildcardModelName(selectedModel.name) ? (
				<WildcardModelSelector
					ariaLabel="Specific model"
					model={selectedModel}
					value={props.targetModel}
					provider={provider}
					onChange={props.onChange}
					placeholder="claude-haiku-4-5"
				/>
			) : null}
		</div>
	);
}

function ProviderBadge(props: { provider: ProviderName }) {
	return (
		<span className="badge provider-badge">
			<ProviderIcon provider={props.provider} />
			{providerDisplayName(props.provider)}
		</span>
	);
}

function ModelProviderBadge(props: { model: LlmModel; providers: LlmProvider[] }) {
	const reference = providerReferenceName(props.model.provider);
	if (reference) {
		const shared = props.providers.find(provider => provider.name === reference);
		const provider = shared ? providerLabel(shared.provider) : 'custom';
		return (
			<Link
				className="badge provider-badge badge-link"
				to="/llm/providers"
				search={{ provider: reference }}
			>
				<ProviderIcon provider={provider as ProviderName} />
				{reference}
				<span className="muted">reference</span>
			</Link>
		);
	}
	return <ProviderBadge provider={providerLabel(props.model.provider) as ProviderName} />;
}

function ModelPolicyState(props: { model: LlmModel; warnings: number }) {
	const policies = [
		props.model.defaults && Object.keys(props.model.defaults).length ? 'defaults' : null,
		props.model.overrides && Object.keys(props.model.overrides).length ? 'overrides' : null,
		props.model.transformation && Object.keys(props.model.transformation).length
			? 'transformation'
			: null,
		props.model.finalTransformation && Object.keys(props.model.finalTransformation).length
			? 'finalTransformation'
			: null,
		props.model.requestHeaders ? 'requestHeaders' : null,
		props.model.responseHeaders ? 'responseHeaders' : null,
		props.model.health ? 'health' : null,
		props.model.authorization ? 'authorization' : null,
		props.model.promptCaching ? 'promptCaching' : null
	].filter(Boolean);
	if (props.warnings > 0) return <span className="badge warn">{props.warnings} warnings</span>;
	if (props.model.auth) return <span className="badge">Custom auth detected</span>;
	if (policies.length > 0)
		return (
			<span className="badge ok">
				{policies.length} {policies.length === 1 ? 'policy' : 'policies'}
			</span>
		);
	return <span className="badge">none</span>;
}

function parseOptionalYamlMapping(text: string) {
	const trimmed = text.trim();
	if (!trimmed || trimmed === '{}') return null;
	const parsed = parseYamlText(trimmed);
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error('Expected a YAML mapping.');
	}
	return parsed as Record<string, unknown>;
}

function optionalMappingYamlText(value: Record<string, unknown> | null | undefined) {
	return value && Object.keys(value).length ? toYamlText(value) : '';
}

function modelConfigForDisplay(model: LlmModel | undefined) {
	if (!model) return {};
	const { id: _id, ...config } = model;
	return config;
}

function initialUpstreamMode(model: LlmModel): UpstreamModelMode {
	if (model.params?.model) return 'explicit';
	const expression = model.transformation?.model;
	if (expression && expression === stripPrefixExpression(stripPrefixCandidate(model.name)))
		return 'strip';
	if (expression) return 'custom';
	return 'incoming';
}

function stripPrefixCandidate(name: string) {
	const slash = name.indexOf('/');
	if (slash < 0) return null;
	return name.slice(0, slash + 1);
}

function stripPrefixExpression(prefix: string | null) {
	if (!prefix) return null;
	return `llmRequest.model.stripPrefix("${prefix}")`;
}

function defaultIncomingModelMatch(provider: LlmModel['provider']) {
	const providerName = providerReferenceName(provider) ?? providerLabel(provider);
	return `${providerName === 'openAI' ? 'openai' : providerName || 'model'}/*`;
}

function applyUpstreamMode(
	model: LlmModel,
	mode: UpstreamModelMode,
	explicitModel: string,
	customModelExpression: string
): LlmModel {
	const next: LlmModel = structuredClone(model);
	next.name = next.name.trim();
	explicitModel = explicitModel.trim();
	const transformation = { ...(next.transformation ?? {}) };
	delete transformation.model;
	const prefixExpression = stripPrefixExpression(stripPrefixCandidate(next.name));

	if (mode === 'strip' && prefixExpression) {
		transformation.model = prefixExpression;
	} else if (mode === 'custom' && customModelExpression.trim()) {
		transformation.model = customModelExpression.trim();
	}

	next.transformation = Object.keys(transformation).length ? transformation : null;

	if (providerReferenceName(next.provider)) {
		next.params = mode === 'explicit' && explicitModel ? { model: explicitModel } : undefined;
		return next;
	}
	next.params = { ...(next.params ?? {}) };

	if (mode === 'explicit') {
		next.params.model = explicitModel || null;
	} else {
		next.params.model = null;
	}

	return next;
}

function expressionMap(value: LlmModel['transformation']): Record<string, string> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
	return Object.fromEntries(
		Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
	);
}

function authorizationSummary(value: AuthorizationDraft | null | undefined) {
	const rules = Array.isArray(value?.rules) ? value.rules : [];
	if (!rules.length) return 'No authorization rules configured';
	return `${rules.length} ${rules.length === 1 ? 'rule' : 'rules'} configured`;
}
