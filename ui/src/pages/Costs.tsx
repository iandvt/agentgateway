import { Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';

import { ConfigSaveButton } from '@/components/ConfigDiffDrawer';
import { EmptyState, formatNumber, PageHeader, Panel, StatusBanner } from '@/components/Primitives';
import {
	type CostCatalogSource,
	configuredCostSources,
	refreshBaseCostsAndConfigure
} from '@/costs';
import {
	takeHybridFileWriteOverride,
	useLlmConfigData,
	useUpdateConfig,
	useUpsertConfigResource
} from '@/hooks';

type CustomCostRow = {
	provider: string;
	model: string;
	input: string;
	output: string;
	cacheRead: string;
	cacheWrite: string;
};

type DisplayCostSource = CostCatalogSource & {
	storage: 'Database' | 'File';
	label: string;
};

export function CostsPage() {
	const {
		hybrid,
		rawConfig,
		resources,
		configResources,
		isLoading: configDataLoading,
		error: configDataError
	} = useLlmConfigData();
	const updateConfig = useUpdateConfig();
	const upsertResource = useUpsertConfigResource();
	const [refreshing, setRefreshing] = useState(false);
	const [message, setMessage] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const catalogResource = useMemo(
		() => resources?.find(resource => resource.kind === 'modelCatalog'),
		[resources]
	);
	const catalog = useMemo(
		() =>
			record(catalogResource?.value) as {
				base?: unknown;
				custom?: unknown;
			},
		[catalogResource]
	);
	const sources = useMemo(
		() => [
			...databaseCostSources(catalog),
			...configuredCostSources(rawConfig.data).map(fileCostSource)
		],
		[rawConfig.data, catalog]
	);
	const baseFile = useMemo(
		() => configuredCostSources(rawConfig.data).find(source => source.file)?.file,
		[rawConfig.data]
	);
	const customRows = useMemo(
		() =>
			inlineCostRows(
				hybrid
					? catalog.custom === undefined
						? []
						: [{ inline: catalog.custom }]
					: catalog.custom === undefined
						? sources
						: [{ inline: catalog.custom }]
			),
		[catalog.custom, hybrid, sources]
	);
	const saving = updateConfig.isPending || upsertResource.isPending;
	const [editingCustom, setEditingCustom] = useState(false);
	const [customError, setCustomError] = useState<string | null>(null);
	const { control, getValues, register, setValue } = useForm<{ rows: CustomCostRow[] }>({
		defaultValues: { rows: customRows }
	});
	const { append, fields, remove } = useFieldArray({ control, name: 'rows' });

	// Read-only rows follow the saved catalog, so they resync whenever it changes outside an edit.
	useEffect(() => {
		if (!editingCustom) setValue('rows', customRows);
	}, [customRows, editingCustom, setValue]);

	async function refreshCosts() {
		// ConfigSaveButton records file overrides for useUpdateConfig, but this endpoint writes the catalog directly.
		if (hybrid && baseFile) takeHybridFileWriteOverride();
		setRefreshing(true);
		setError(null);
		setMessage(null);
		try {
			const refreshed = await refreshBaseCostsAndConfigure(updateConfig);
			if (hybrid) await configResources.refetch();
			setMessage(
				`Base cost catalog refreshed: ${formatNumber(refreshed.models)} models from ${formatNumber(refreshed.providers)} providers.`
			);
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to refresh base cost catalog');
		} finally {
			setRefreshing(false);
		}
	}

	return (
		<div className="page-stack">
			<PageHeader
				title="LLM Costs"
				description="Manage model cost catalogs used for analytics and request cost attribution."
				actions={
					<ConfigSaveButton
						disabled={refreshing || saving}
						allowHybridWrite={!baseFile}
						hybridFileWriteMessage={`Base costs are stored in ${baseFile}. File writes are disabled in hybrid mode.`}
						onClick={() => void refreshCosts()}
					>
						<RefreshCw size={16} />
						Refresh base costs
					</ConfigSaveButton>
				}
			/>
			{configDataLoading ? (
				<StatusBanner state="loading" title="Loading cost configuration" />
			) : configDataError ? (
				<StatusBanner state="bad" title="Configuration API unavailable">
					{configDataError.message}
				</StatusBanner>
			) : null}
			{error ? (
				<StatusBanner state="bad" title="Cost refresh failed">
					{error}
				</StatusBanner>
			) : null}
			{message ? <StatusBanner state="ok" title={message} /> : null}
			<Panel>
				<div className="editor-title">
					<div>
						<h3>Catalog sources</h3>
						<p>
							Sources are merged in order. Database sources load first, and later file sources
							override them.
						</p>
					</div>
				</div>
				{sources.length ? (
					<div className="table-wrap">
						<table className="data-table">
							<thead>
								<tr>
									<th>Storage</th>
									<th>Source</th>
									<th>Type</th>
								</tr>
							</thead>
							<tbody>
								{/* Keyed by the sources' content, so a changed list remounts with new row ids. */}
								<SourceRows key={JSON.stringify(sources)} sources={sources} />
							</tbody>
						</table>
					</div>
				) : (
					<EmptyState
						title="Using the embedded cost catalog"
						description="Agentgateway includes a built-in catalog of model pricing. Refresh the base catalog to get the latest pricing data."
					/>
				)}
			</Panel>
			<Panel>
				<div className="editor-title">
					<div>
						<h3>Custom costs</h3>
						<p>
							Inline overrides stored in this gateway configuration. Values are USD per 1M tokens.
						</p>
					</div>
					<div className="button-row compact">
						{editingCustom ? (
							<>
								<button
									className="button"
									type="button"
									disabled={saving}
									onClick={() => {
										setValue('rows', customRows);
										setCustomError(null);
										setEditingCustom(false);
									}}
								>
									Cancel
								</button>
								<button
									className="button primary"
									type="button"
									disabled={saving}
									onClick={() => void saveCustomCosts()}
								>
									Save
								</button>
							</>
						) : (
							<button className="button" type="button" onClick={() => setEditingCustom(true)}>
								Edit
							</button>
						)}
					</div>
				</div>
				{customError ? (
					<StatusBanner state="bad" title="Invalid custom costs">
						{customError}
					</StatusBanner>
				) : null}
				<div className="table-wrap custom-cost-table-wrap">
					<table className="data-table custom-cost-table">
						<thead>
							<tr>
								<th>Provider</th>
								<th>Model</th>
								<th>Input</th>
								<th>Output</th>
								<th>Cache read</th>
								<th>Cache write</th>
								{editingCustom ? <th aria-label="Actions" /> : null}
							</tr>
						</thead>
						<tbody>
							{editingCustom ? (
								fields.map((field, index) => (
									<tr key={field.id}>
										<td>
											<input {...register(`rows.${index}.provider`)} placeholder="openai" />
										</td>
										<td>
											<input {...register(`rows.${index}.model`)} placeholder="gpt-5-mini" />
										</td>
										<td>
											<input
												className="cost-rate-input"
												{...register(`rows.${index}.input`)}
												placeholder="0.25"
											/>
										</td>
										<td>
											<input
												className="cost-rate-input"
												{...register(`rows.${index}.output`)}
												placeholder="2.00"
											/>
										</td>
										<td>
											<input
												className="cost-rate-input"
												{...register(`rows.${index}.cacheRead`)}
												placeholder="0.025"
											/>
										</td>
										<td>
											<input
												className="cost-rate-input"
												{...register(`rows.${index}.cacheWrite`)}
												placeholder="0.30"
											/>
										</td>
										<td>
											<button
												className="icon-button danger"
												type="button"
												aria-label="Remove custom cost"
												onClick={() => remove(index)}
											>
												<Trash2 size={15} />
											</button>
										</td>
									</tr>
								))
							) : (
								<CostReadRows key={JSON.stringify(customRows)} rows={customRows} />
							)}
							{editingCustom && fields.length === 0 ? (
								<tr>
									<td colSpan={7}>
										<span className="muted-copy inline">No custom costs.</span>
									</td>
								</tr>
							) : null}
							{!editingCustom && customRows.length === 0 ? (
								<tr>
									<td colSpan={6}>
										<span className="muted-copy inline">No custom costs.</span>
									</td>
								</tr>
							) : null}
						</tbody>
					</table>
				</div>
				{editingCustom ? (
					<div className="button-row custom-cost-actions">
						<button className="button" type="button" onClick={() => append(emptyCustomCostRow())}>
							<Plus size={16} />
							Add model cost
						</button>
					</div>
				) : null}
			</Panel>
		</div>
	);

	async function saveCustomCosts() {
		setCustomError(null);
		const rows = getValues('rows');
		const validationError = validateCustomRows(rows);
		if (validationError) {
			setCustomError(validationError);
			return;
		}
		try {
			await upsertResource.mutateAsync({
				kind: 'modelCatalog',
				value: {
					...catalog,
					custom: inlineCatalog(rows)
				}
			});
			setEditingCustom(false);
		} catch (err) {
			setCustomError(err instanceof Error ? err.message : 'Failed to save custom costs');
		}
	}
}

// Duplicate file sources are meaningful (later sources override earlier ones), so rows
// cannot be keyed by their values. Each row is the source itself; the caller remounts the
// table when the list changes.
function SourceRows(props: { sources: DisplayCostSource[] }) {
	const { control } = useForm({ defaultValues: { sources: props.sources } });
	const { fields } = useFieldArray({ control, name: 'sources' });
	return fields.map(source => (
		<tr key={source.id}>
			<td>
				<span className="badge">{source.storage}</span>
			</td>
			<td>
				<code>{source.label}</code>
			</td>
			<td>{sourceType(source)}</td>
		</tr>
	));
}

// Read-only custom cost rows come straight from the saved catalog. Each row is the catalog
// row itself; the caller remounts the table when the rows change.
function CostReadRows(props: { rows: CustomCostRow[] }) {
	const { control } = useForm({ defaultValues: { rows: props.rows } });
	const { fields } = useFieldArray({ control, name: 'rows' });
	return fields.map(row => (
		<tr key={row.id}>
			<td>{row.provider}</td>
			<td>{row.model}</td>
			<td>{displayRate(row.input)}</td>
			<td>{displayRate(row.output)}</td>
			<td>{displayRate(row.cacheRead)}</td>
			<td>{displayRate(row.cacheWrite)}</td>
		</tr>
	));
}

function databaseCostSources(catalog: { base?: unknown; custom?: unknown }): DisplayCostSource[] {
	const sources: DisplayCostSource[] = [];
	if (catalog.base !== undefined) {
		sources.push({
			inline: catalog.base,
			storage: 'Database',
			label: 'Base catalog'
		});
	}
	if (catalog.custom !== undefined) {
		sources.push({
			inline: catalog.custom,
			storage: 'Database',
			label: 'Custom overrides'
		});
	}
	return sources;
}

function fileCostSource(source: CostCatalogSource): DisplayCostSource {
	return {
		...source,
		storage: 'File',
		label: sourceLabel(source)
	};
}

function sourceType(source: CostCatalogSource) {
	if (source.file) return 'File';
	if ('inline' in source) return 'Inline';
	return 'Unknown';
}

function sourceLabel(source: CostCatalogSource) {
	if (source.file) return source.file;
	if ('inline' in source) return 'Custom inline overlay';
	return 'Unknown source';
}

function emptyCustomCostRow(): CustomCostRow {
	return {
		provider: '',
		model: '',
		input: '',
		output: '',
		cacheRead: '',
		cacheWrite: ''
	};
}

function inlineCostRows(sources: CostCatalogSource[]): CustomCostRow[] {
	const rows: CustomCostRow[] = [];
	for (const source of sources) {
		if (!('inline' in source)) continue;
		const providers = record(source.inline)?.providers;
		for (const [providerName, provider] of Object.entries(record(providers))) {
			const models = record(provider).models;
			for (const [modelName, model] of Object.entries(record(models))) {
				const rates = record(model).rates;
				rows.push({
					provider: providerName,
					model: modelName,
					input: stringValue(record(rates).input),
					output: stringValue(record(rates).output),
					cacheRead: stringValue(record(rates).cacheRead),
					cacheWrite: stringValue(record(rates).cacheWrite)
				});
			}
		}
	}
	return rows.sort(
		(a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model)
	);
}

function inlineCatalog(rows: CustomCostRow[]) {
	const providers: Record<string, { models: Record<string, { rates: Record<string, string> }> }> =
		{};
	for (const row of rows) {
		const provider = row.provider.trim();
		const model = row.model.trim();
		if (!provider || !model) continue;
		const rates = cleanRates({
			input: row.input,
			output: row.output,
			cacheRead: row.cacheRead,
			cacheWrite: row.cacheWrite
		});
		if (!Object.keys(rates).length) continue;
		providers[provider] = providers[provider] ?? { models: {} };
		providers[provider].models[model] = { rates };
	}
	return { providers };
}

function cleanRates(rates: Record<string, string>) {
	return Object.fromEntries(
		Object.entries(rates)
			.map(([key, value]) => [key, value.trim()])
			.filter(([, value]) => value)
	);
}

function validateCustomRows(rows: CustomCostRow[]) {
	for (const row of rows) {
		const hasAny = Object.values(row).some(value => value.trim());
		if (!hasAny) continue;
		if (!row.provider.trim()) return 'Provider is required for every custom cost row.';
		if (!row.model.trim()) return 'Model is required for every custom cost row.';
		const rates = [row.input, row.output, row.cacheRead, row.cacheWrite].filter(value =>
			value.trim()
		);
		if (!rates.length) return `${row.provider}/${row.model} needs at least one rate.`;
		for (const rate of rates) {
			if (!/^\d+(\.\d{1,6})?$/.test(rate.trim()))
				return `Invalid rate "${rate}". Use a non-negative decimal with up to 6 decimal places.`;
		}
	}
	return null;
}

function displayRate(value: string) {
	return value || '—';
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function stringValue(value: unknown) {
	return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}
