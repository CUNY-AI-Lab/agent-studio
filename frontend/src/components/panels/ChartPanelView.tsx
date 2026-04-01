import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  XAxis,
  YAxis,
} from 'recharts';
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '../ui/chart';
import type { WorkspacePanel } from '../../types';

function inferChartKeys(data: Array<Record<string, string | number | boolean | null>>) {
  const sample = data.find((row) => row && Object.keys(row).length > 0);
  if (!sample) {
    return { labelKey: null, valueKey: null };
  }

  const entries = Object.entries(sample);
  const numericEntry = entries.find(([, value]) => typeof value === 'number');
  const labelEntry = entries.find(([key]) => key !== numericEntry?.[0]) || entries[0];

  return {
    labelKey: labelEntry?.[0] ?? null,
    valueKey: numericEntry?.[0] ?? entries.find(([, value]) => value != null)?.[0] ?? null,
  };
}

export default function ChartPanelView({
  panel,
}: {
  panel: Extract<WorkspacePanel, { type: 'chart' }>;
}) {
  if (panel.data.length === 0) {
    return <div className="panel-empty">No chart data yet.</div>;
  }

  const { labelKey, valueKey } = inferChartKeys(panel.data);
  const xKey = labelKey || 'label';
  const yKey = valueKey || 'value';
  const colors = ['#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6'];
  const reservedProps = ['style', 'className', 'key', 'ref', 'children'];
  const sanitizedData = panel.data.map((item) => {
    const clean: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(item)) {
      if (!reservedProps.includes(key)) {
        clean[key] = value;
      }
    }
    return clean;
  });

  const chartConfig = {
    [yKey]: {
      label: yKey.charAt(0).toUpperCase() + yKey.slice(1),
      color: colors[0],
    },
  };

  return (
    <div className="h-full w-full bg-card rounded-lg">
      <ChartContainer config={chartConfig} className="h-full w-full">
        {panel.chartType === 'bar' ? (
          <BarChart data={sanitizedData} margin={{ top: 10, right: 10, left: 0, bottom: 40 }}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-muted/50" />
            <XAxis dataKey={xKey} tick={{ fontSize: 10 }} angle={-45} textAnchor="end" height={50} className="fill-muted-foreground" />
            <YAxis tick={{ fontSize: 10 }} className="fill-muted-foreground" />
            <ChartTooltip content={<ChartTooltipContent />} />
            <Bar dataKey={yKey} fill={colors[0]} radius={[4, 4, 0, 0]} />
          </BarChart>
        ) : panel.chartType === 'line' ? (
          <LineChart data={sanitizedData} margin={{ top: 10, right: 10, left: 0, bottom: 40 }}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-muted/50" />
            <XAxis dataKey={xKey} tick={{ fontSize: 10 }} angle={-45} textAnchor="end" height={50} className="fill-muted-foreground" />
            <YAxis tick={{ fontSize: 10 }} className="fill-muted-foreground" />
            <ChartTooltip content={<ChartTooltipContent />} />
            <Line type="monotone" dataKey={yKey} stroke={colors[0]} strokeWidth={2} dot={{ fill: colors[0] }} />
          </LineChart>
        ) : panel.chartType === 'area' ? (
          <AreaChart data={sanitizedData} margin={{ top: 10, right: 10, left: 0, bottom: 40 }}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-muted/50" />
            <XAxis dataKey={xKey} tick={{ fontSize: 10 }} angle={-45} textAnchor="end" height={50} className="fill-muted-foreground" />
            <YAxis tick={{ fontSize: 10 }} className="fill-muted-foreground" />
            <ChartTooltip content={<ChartTooltipContent />} />
            <Area type="monotone" dataKey={yKey} stroke={colors[1]} strokeWidth={2} fill={`${colors[1]}80`} />
          </AreaChart>
        ) : panel.chartType === 'pie' ? (
          <PieChart>
            <ChartTooltip content={<ChartTooltipContent />} />
            <Pie
              data={sanitizedData}
              dataKey={yKey}
              nameKey={xKey}
              cx="50%"
              cy="50%"
              outerRadius="70%"
              label={({ name, percent }) => `${name}: ${((percent ?? 0) * 100).toFixed(0)}%`}
              labelLine={false}
            >
              {sanitizedData.map((_, index) => (
                <Cell key={`cell-${index}`} fill={colors[index % colors.length]} />
              ))}
            </Pie>
          </PieChart>
        ) : (
          <div className="text-muted-foreground">Unknown chart type</div>
        )}
      </ChartContainer>
    </div>
  );
}
